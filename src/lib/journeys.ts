import { all, db, J, one, run, tx } from "./db";
import { audit, Actor, SYSTEM } from "./audit";
import { evaluate, isPromotional, Purpose } from "./compliance";
import { matchIds, Rule } from "./segments";
import { getActiveStrategy, getVersion } from "./strategy";
import { sendMessages, cancelPendingMessages } from "./messaging";
import { createApproval } from "./approvals";
import { decideForPlayers, issueOne } from "./offers";
import { addHours, bucket, HttpError, id, nowIso, ORG_ID } from "./util";
import { publish, notify } from "./stream";

export type JNode = { id: string; type: "trigger" | "condition" | "action" | "flow"; kind: string; data: Record<string, unknown>; position?: { x: number; y: number } };
export type JEdge = { id: string; source: string; target: string; sourceHandle?: string | null };
export type JourneyDef = { nodes: JNode[]; edges: JEdge[]; exit?: { on_trigger_segment_exit?: boolean; rule?: Rule } };
export type Journey = { id: string; name: string; description: string | null; purpose: string; status: string; draft_definition: string; published_version: number | null; strategy_category: string | null; created_at: string; updated_at: string };

export const NODE_CATALOG = {
  trigger: ["event_trigger", "segment_entry", "segment_exit", "scheduled", "manual", "webhook", "api"],
  condition: ["user_attribute", "user_tag", "segment_membership", "event_condition", "channel_availability", "consent", "eligibility", "compliance"],
  action: ["send_message", "create_ticket", "update_tag", "update_segment", "evaluate_entitlement", "issue_entitlement", "call_webhook", "notify_employee", "request_approval"],
  flow: ["wait", "delay", "branch", "parallel", "random_split", "ab_test", "exit_condition", "end"],
} as const;
const BRANCHING = new Set(["condition:*", "flow:branch", "flow:random_split", "flow:ab_test", "flow:exit_condition"]);
const isBranching = (n: JNode) => n.type === "condition" || BRANCHING.has(`${n.type}:${n.kind}`);

export type ValidationIssue = { level: "error" | "warning"; node?: string; edge?: string; message: string };
export function validate(def: JourneyDef, purpose: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set(def.nodes.map((n) => n.id));
  const triggers = def.nodes.filter((n) => n.type === "trigger");
  if (!triggers.length) issues.push({ level: "error", message: "Journey needs at least one trigger" });
  for (const n of def.nodes) {
    if (!(NODE_CATALOG[n.type] as readonly string[])?.includes(n.kind)) issues.push({ level: "error", node: n.id, message: `Unsupported node ${n.type}:${n.kind}` });
  }
  for (const e of def.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) issues.push({ level: "error", edge: e.id, message: "Edge references a missing node" });
    const tgt = def.nodes.find((n) => n.id === e.target);
    if (tgt?.type === "trigger") issues.push({ level: "error", edge: e.id, message: "Triggers cannot have incoming connections" });
    const src = def.nodes.find((n) => n.id === e.source);
    if (src?.kind === "end") issues.push({ level: "error", edge: e.id, message: "End node cannot have outgoing connections" });
    if (e.source === e.target) issues.push({ level: "error", edge: e.id, message: "Self-loop" });
  }
  // cycles (unsupported)
  const adj = new Map<string, string[]>();
  for (const e of def.edges) adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
  const color = new Map<string, number>();
  const dfs = (u: string): boolean => { color.set(u, 1); for (const v of adj.get(u) ?? []) { if (color.get(v) === 1) return true; if (!color.get(v) && dfs(v)) return true; } color.set(u, 2); return false; };
  for (const n of def.nodes) if (!color.get(n.id) && dfs(n.id)) { issues.push({ level: "error", message: "Unsupported cycle detected — journeys must be acyclic (use Wait + exit rules instead of loops)" }); break; }
  // reachability
  const seen = new Set<string>(); const stack = triggers.map((t) => t.id);
  while (stack.length) { const u = stack.pop()!; if (seen.has(u)) continue; seen.add(u); stack.push(...(adj.get(u) ?? [])); }
  for (const n of def.nodes) if (!seen.has(n.id)) issues.push({ level: "warning", node: n.id, message: "Node is not reachable from any trigger" });
  for (const n of def.nodes) {
    const outs = def.edges.filter((e) => e.source === n.id);
    if (isBranching(n)) {
      const handles = new Set(outs.map((o) => o.sourceHandle ?? "yes"));
      const need = n.kind === "random_split" || n.kind === "ab_test" ? ["a", "b"] : ["yes", "no"];
      for (const h of need) if (!handles.has(h)) issues.push({ level: "warning", node: n.id, message: `Branch '${h}' is not connected (players taking it will finish)` });
    } else if (n.kind !== "end" && !outs.length && n.type !== "trigger") issues.push({ level: "warning", node: n.id, message: "No outgoing connection — players finish here" });
    if (n.type === "trigger" && !outs.length) issues.push({ level: "error", node: n.id, message: "Trigger is not connected" });
    if (n.kind === "send_message") {
      if (!n.data.channel) issues.push({ level: "error", node: n.id, message: "Send Message needs a channel" });
      if (!n.data.template_id) issues.push({ level: "error", node: n.id, message: "Send Message needs an approved template" });
      else {
        const t = one<{ status: string; purpose: string }>("SELECT status, purpose FROM message_templates WHERE id = ?", n.data.template_id);
        if (!t) issues.push({ level: "error", node: n.id, message: "Template not found" });
        else {
          if (t.status !== "approved") issues.push({ level: "error", node: n.id, message: "Template is not approved" });
          if (isPromotional(t.purpose) && !isPromotional(purpose)) issues.push({ level: "error", node: n.id, message: "Promotional template in a service journey" });
        }
      }
    }
    if ((n.kind === "segment_entry" || n.kind === "segment_exit") && !n.data.segment_id) issues.push({ level: "error", node: n.id, message: "Select a segment" });
    if ((n.kind === "issue_entitlement" || n.kind === "evaluate_entitlement") && !n.data.offer_id) issues.push({ level: "error", node: n.id, message: "Select an offer" });
    if ((n.kind === "wait" || n.kind === "delay") && n.data.hours == null && !n.data.strategy_param) issues.push({ level: "error", node: n.id, message: "Wait needs hours or a strategy parameter" });
  }
  return issues;
}

export function saveDraft(journeyId: string, def: JourneyDef, actor: Actor) {
  const j = getJourney(journeyId);
  run("UPDATE journeys SET draft_definition = ?, updated_at = ? WHERE id = ?", J.str(def), nowIso(), journeyId);
  audit(actor, "journey.draft_saved", "journey", journeyId, { nodes: def.nodes.length, edges: def.edges.length });
  return { ...j, draft_definition: J.str(def) };
}
export function getJourney(journeyId: string) {
  const j = one<Journey>("SELECT * FROM journeys WHERE id = ?", journeyId);
  if (!j) throw new HttpError(404, "Journey not found");
  return j;
}

/** Publish: service journeys go live directly for authorized users; promotional / entitlement journeys require approval. */
export function publishJourney(journeyId: string, actor: Actor) {
  const j = getJourney(journeyId);
  const def = J.parse<JourneyDef>(j.draft_definition, { nodes: [], edges: [] });
  const issues = validate(def, j.purpose);
  if (issues.some((i) => i.level === "error")) throw new HttpError(422, "Journey has validation errors", issues);
  const v = (one<{ v: number }>("SELECT MAX(version) v FROM journey_versions WHERE journey_id = ?", journeyId)?.v ?? 0) + 1;
  const strat = j.strategy_category ? getActiveStrategy(j.strategy_category) : null;
  const needsApproval = isPromotional(j.purpose) || def.nodes.some((n) => n.kind === "issue_entitlement");
  run("INSERT INTO journey_versions (journey_id, version, definition, strategy_id, strategy_version, status, published_by, published_at) VALUES (?,?,?,?,?,?,?,?)",
    journeyId, v, J.str(def), strat?.strategyId ?? null, strat?.version ?? null, needsApproval ? "pending_approval" : "published", actor.id, needsApproval ? null : nowIso());
  if (needsApproval) {
    const a = createApproval({ entityType: "journey_version", entityId: `${journeyId}:${v}`, title: `Publish journey ${j.name} v${v}`, summary: `${def.nodes.length} nodes, purpose ${j.purpose}`, risk: "medium", requestedBy: actor.id });
    run("UPDATE journey_versions SET approval_id = ? WHERE journey_id = ? AND version = ?", a.id, journeyId, v);
    audit(actor, "journey.publish_requested", "journey", journeyId, { version: v });
    return { version: v, status: "pending_approval", approvalId: a.id, issues };
  }
  activateVersion(journeyId, v, actor);
  return { version: v, status: "published", issues };
}
function activateVersion(journeyId: string, v: number, actor: Actor) {
  run("UPDATE journey_versions SET status = 'superseded' WHERE journey_id = ? AND status = 'published' AND version != ?", journeyId, v);
  run("UPDATE journey_versions SET status = 'published', published_at = ? WHERE journey_id = ? AND version = ?", nowIso(), journeyId, v);
  run("UPDATE journeys SET status = 'active', published_version = ?, updated_at = ? WHERE id = ?", v, nowIso(), journeyId);
  audit(actor, "journey.published", "journey", journeyId, { version: v, note: "running executions stay pinned to their version" });
  publish("journeys", "journey.published", { journey_id: journeyId, version: v }, journeyId);
}
export function onApprovalDecided(entityId: string, status: string, actor: Actor) {
  const [jid, v] = entityId.split(":");
  if (status === "approved") activateVersion(jid, Number(v), actor);
  else run("UPDATE journey_versions SET status = ? WHERE journey_id = ? AND version = ?", status === "rejected" ? "rejected" : "draft", jid, Number(v));
}

export function setJourneyStatus(journeyId: string, status: "paused" | "active" | "stopped", actor: Actor) {
  const j = getJourney(journeyId);
  if (status === "active" && !j.published_version) throw new HttpError(409, "Publish the journey first");
  run("UPDATE journeys SET status = ?, updated_at = ? WHERE id = ?", status, nowIso(), journeyId);
  if (status === "stopped") run("UPDATE journey_executions SET status = 'exited', exit_reason = 'journey_stopped', updated_at = ? WHERE journey_id = ? AND status IN ('active','waiting')", nowIso(), journeyId);
  audit(actor, `journey.${status}`, "journey", journeyId, {});
  publish("journeys", "journey.status", { journey_id: journeyId, status }, journeyId);
  if (status === "active") processDue();
}

// ───── execution ─────
type Exec = { id: string; journey_id: string; version: number; player_id: string; status: string; current_node: string | null; wake_at: string | null; strategy_version: number | null; history: string };

export function enroll(journeyId: string, playerIds: string[], reason: string) {
  const j = getJourney(journeyId);
  if (!j.published_version || j.status !== "active") return { enrolled: 0, duplicates: 0 };
  const ver = one<{ definition: string; strategy_version: number | null }>("SELECT definition, strategy_version FROM journey_versions WHERE journey_id = ? AND version = ?", journeyId, j.published_version)!;
  const def = J.parse<JourneyDef>(ver.definition, { nodes: [], edges: [] });
  const trig = def.nodes.find((n) => n.type === "trigger")!;
  const waitHours = j.strategy_category ? strategyParam(ver.strategy_version, j.strategy_category, "reminder_wait_hours") : undefined;
  let enrolled = 0, duplicates = 0;
  const ins = db().prepare("INSERT OR IGNORE INTO journey_executions (id, journey_id, version, player_id, status, current_node, strategy_version, history, started_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const created: string[] = [];
  tx(() => {
    for (const pid of playerIds) {
      const eid = id("jex");
      const info = ins.run(eid, journeyId, j.published_version, pid, "active", trig.id, ver.strategy_version, J.str([{ node: trig.id, at: nowIso(), note: reason, wait_hours: waitHours ?? null }]), nowIso(), nowIso());
      if (info.changes) { enrolled++; created.push(eid); bump(journeyId, j.published_version!, trig.id, "entered"); bump(journeyId, j.published_version!, trig.id, "completed"); }
      else duplicates++;
    }
  });
  for (const e of created) advance(e);
  if (enrolled) publish("journeys", "journey.enrolled", { journey_id: journeyId, enrolled, duplicates }, journeyId);
  return { enrolled, duplicates };
}

function bump(jid: string, v: number, node: string, col: "entered" | "completed" | "errors") {
  run(`INSERT INTO journey_node_stats (journey_id, version, node_id, ${col}) VALUES (?,?,?,1) ON CONFLICT(journey_id, version, node_id) DO UPDATE SET ${col} = ${col} + 1`, jid, v, node);
}

function next(def: JourneyDef, nodeId: string, handle?: string) {
  return def.edges.filter((e) => e.source === nodeId && (handle === undefined || (e.sourceHandle ?? "yes") === handle)).map((e) => e.target);
}

function strategyParam(execStrategyVersion: number | null, category: string | null, key: string): unknown {
  if (!category) return undefined;
  const s = one<{ id: string }>("SELECT id FROM strategies WHERE category = ?", category);
  if (!s) return undefined;
  const v = execStrategyVersion != null ? getVersion(s.id, execStrategyVersion) : null;
  return (v?.config as Record<string, unknown> | undefined)?.[key];
}

/** Evaluate a condition node for a player using the shared segment compiler. */
function conditionHolds(n: JNode, pid: string, purpose: string): boolean {
  const d = n.data;
  switch (n.kind) {
    case "user_attribute": return matchIds({ type: "attr", field: String(d.field), op: (d.op as "eq") ?? "eq", value: d.value }, pid).length > 0;
    case "user_tag": return matchIds({ type: "tag", tag: String(d.tag), has: d.has !== false }, pid).length > 0;
    case "segment_membership": return !!one("SELECT 1 FROM segment_memberships WHERE segment_id = ? AND player_id = ?", d.segment_id, pid);
    case "event_condition": return matchIds({ type: "event", event: String(d.event), op: (d.op as "gte") ?? "gte", count: Number(d.count ?? 1), within_days: Number(d.within_days ?? 7) }, pid).length > 0;
    case "channel_availability": return !!one("SELECT 1 FROM channels WHERE key = ? AND enabled = 1 AND health != 'down'", d.channel);
    case "consent": return !!one("SELECT 1 FROM consent_current c JOIN channels ch ON ch.consent_channel = c.channel WHERE ch.key = ? AND c.player_id = ? AND c.purpose = ? AND c.granted = 1", d.channel, pid, isPromotional(purpose) ? "marketing" : "service");
    case "eligibility": return decideForPlayers(String(d.offer_id), [pid]).decisions[0]?.outcome !== "none";
    case "compliance": return evaluate({ playerIds: [pid], purpose: (d.purpose as Purpose) ?? (purpose as Purpose), action: "targeting", log: false })[0].allowed;
    case "branch": case "exit_condition": return d.rule ? matchIds(d.rule as Rule, pid).length > 0 : false;
  }
  return true;
}

/** Advance one execution until it waits, exits or completes. Every action is idempotent per (execution, node). */
export function advance(execId: string, depth = 0) {
  const ex = one<Exec>("SELECT * FROM journey_executions WHERE id = ?", execId);
  if (!ex || !["active", "waiting"].includes(ex.status)) return;
  const j = getJourney(ex.journey_id);
  if (j.status !== "active") return; // paused: resume picks up later
  const ver = one<{ definition: string }>("SELECT definition FROM journey_versions WHERE journey_id = ? AND version = ?", ex.journey_id, ex.version)!;
  const def = J.parse<JourneyDef>(ver.definition, { nodes: [], edges: [] });
  const hist = J.parse<Array<Record<string, unknown>>>(ex.history, []);
  const save = (fields: Partial<Exec> & { exit_reason?: string }) => {
    const sets = Object.keys(fields).map((k) => `${k} = ?`).join(", ");
    run(`UPDATE journey_executions SET ${sets}, history = ?, updated_at = ? WHERE id = ?`, ...Object.values(fields), J.str(hist), nowIso(), execId);
  };
  // exit rules are re-checked before every step
  if (shouldExit(def, ex)) { hist.push({ at: nowIso(), note: "exit rule matched" }); save({ status: "exited", exit_reason: "exit_rule", current_node: ex.current_node }); return; }

  let queue = next(def, ex.current_node!);
  if (ex.status === "waiting") { queue = next(def, ex.current_node!); }
  const purpose = j.purpose;
  let guard = 0;
  while (queue.length && guard++ < 50) {
    const nodeId = queue.shift()!;
    const n = def.nodes.find((x) => x.id === nodeId);
    if (!n) continue;
    bump(ex.journey_id, ex.version, n.id, "entered");
    hist.push({ node: n.id, kind: n.kind, at: nowIso() });
    try {
      if (n.type === "condition" || n.kind === "branch") { queue.push(...next(def, n.id, conditionHolds(n, ex.player_id, purpose) ? "yes" : "no")); }
      else if (n.kind === "exit_condition") { if (conditionHolds(n, ex.player_id, purpose)) { bump(ex.journey_id, ex.version, n.id, "completed"); save({ status: "exited", exit_reason: "exit_condition", current_node: n.id }); return; } queue.push(...next(def, n.id, "no"), ...next(def, n.id, "yes").slice(0, 0)); }
      else if (n.kind === "random_split" || n.kind === "ab_test") { const pctA = Number(n.data.percent_a ?? 50) / 100; queue.push(...next(def, n.id, bucket(`${ex.id}:${n.id}`) < pctA ? "a" : "b")); }
      else if (n.kind === "parallel") queue.push(...next(def, n.id));
      else if (n.kind === "end") { bump(ex.journey_id, ex.version, n.id, "completed"); save({ status: "completed", current_node: n.id }); return; }
      else if (n.kind === "wait" || n.kind === "delay") {
        const hours = Number(n.data.strategy_param ? strategyParam(ex.strategy_version, j.strategy_category, String(n.data.strategy_param)) ?? n.data.hours ?? 24 : n.data.hours ?? 24);
        bump(ex.journey_id, ex.version, n.id, "completed");
        hist.push({ node: n.id, note: `waiting ${hours}h`, at: nowIso() });
        save({ status: "waiting", current_node: n.id, wake_at: addHours(nowIso(), hours) });
        return;
      } else if (n.type === "action") {
        const r = runAction(n, ex, purpose);
        hist.push({ node: n.id, result: r, at: nowIso() });
        queue.push(...next(def, n.id));
      }
      bump(ex.journey_id, ex.version, n.id, "completed");
    } catch (e) {
      bump(ex.journey_id, ex.version, n.id, "errors");
      hist.push({ node: n.id, error: (e as Error).message, at: nowIso() });
      save({ status: "error", current_node: n.id });
      return;
    }
  }
  save({ status: "completed", current_node: ex.current_node, wake_at: null });
  void depth;
}

function shouldExit(def: JourneyDef, ex: Exec) {
  if (def.exit?.rule && matchIds(def.exit.rule, ex.player_id).length > 0) return true;
  if (def.exit?.on_trigger_segment_exit) {
    const t = def.nodes.find((n) => n.kind === "segment_entry");
    if (t && !one("SELECT 1 FROM segment_memberships WHERE segment_id = ? AND player_id = ?", t.data.segment_id, ex.player_id)) return true;
  }
  return false;
}

function runAction(n: JNode, ex: Exec, purpose: string) {
  const actor: Actor = { type: "system", id: `journey:${ex.journey_id}` };
  const key = `journey:${ex.id}:${n.id}`;
  const d = n.data;
  switch (n.kind) {
    case "send_message": {
      const r = sendMessages({ playerIds: [ex.player_id], channel: String(d.channel), purpose: purpose as Purpose, templateId: String(d.template_id), idempotencyPrefix: key, journeyId: ex.journey_id, actor, context: "journey" });
      return { sent: r.sent, blocked: r.blocked, duplicate: r.duplicates, reasons: r.blockedDetails[0]?.reasons };
    }
    case "create_ticket": {
      const tid = `tkt_${key.slice(-24)}`;
      run("INSERT OR IGNORE INTO service_tickets (id, player_id, category, subject, status, priority, source, created_at) VALUES (?,?,?,?,?,?,?,?)", tid, ex.player_id, String(d.category ?? "general"), String(d.subject ?? "Journey follow-up"), "open", "normal", "journey", nowIso());
      return { ticket: tid };
    }
    case "update_tag": {
      const tag = one<{ id: string }>("SELECT id FROM tags WHERE key = ?", d.tag);
      if (!tag) throw new Error(`Unknown tag ${d.tag}`);
      if (d.add === false) run("DELETE FROM customer_tags WHERE player_id = ? AND tag_id = ?", ex.player_id, tag.id);
      else run("INSERT OR IGNORE INTO customer_tags (player_id, tag_id, source, added_at) VALUES (?,?,?,?)", ex.player_id, tag.id, "journey", nowIso());
      return { tag: d.tag };
    }
    case "update_segment": {
      if (d.add === false) run("DELETE FROM segment_memberships WHERE segment_id = ? AND player_id = ?", d.segment_id, ex.player_id);
      else run("INSERT OR IGNORE INTO segment_memberships (segment_id, player_id, joined_at) VALUES (?,?,?)", d.segment_id, ex.player_id, nowIso());
      return { segment: d.segment_id };
    }
    case "evaluate_entitlement": { const dd = decideForPlayers(String(d.offer_id), [ex.player_id]).decisions[0]; return { outcome: dd.outcome, amount: dd.approved_amount, reason: dd.reason }; }
    case "issue_entitlement": {
      const dd = decideForPlayers(String(d.offer_id), [ex.player_id]).decisions[0];
      if (dd.outcome === "none") return { issued: false, reason: dd.reason };
      return issueOne(String(d.offer_id), ex.player_id, dd.approved_amount, key, null, actor);
    }
    case "call_webhook": return { webhook: "mock", url: d.url, note: "Outbound webhooks are mocked until an integration is enabled" };
    case "notify_employee": notify("journey", "Journey notification", String(d.message ?? "Journey step"), `/journeys/${ex.journey_id}`); return { notified: true };
    case "request_approval": createApproval({ entityType: "journey_step", entityId: key, title: String(d.title ?? "Journey approval"), summary: `Player ${ex.player_id}`, risk: "medium", requestedBy: actor.id }); return { approval: true };
  }
  return {};
}

export function processDue() {
  const due = all<{ id: string }>("SELECT id FROM journey_executions WHERE status = 'waiting' AND wake_at <= ? LIMIT 5000", nowIso());
  for (const d of due) { run("UPDATE journey_executions SET status = 'active' WHERE id = ?", d.id); advance(d.id); }
  return due.length;
}

export function onSegmentChange(segmentId: string, entered: string[], exited: string[]) {
  const js = all<Journey & { definition: string }>("SELECT j.*, v.definition FROM journeys j JOIN journey_versions v ON v.journey_id = j.id AND v.version = j.published_version WHERE j.status = 'active'");
  for (const j of js) {
    const def = J.parse<JourneyDef>(j.definition, { nodes: [], edges: [] });
    const trig = def.nodes.find((n) => n.type === "trigger");
    if (trig?.kind === "segment_entry" && trig.data.segment_id === segmentId && entered.length) enroll(j.id, entered, `segment_entry:${segmentId}`);
    if (trig?.kind === "segment_exit" && trig.data.segment_id === segmentId && exited.length) enroll(j.id, exited, `segment_exit:${segmentId}`);
    if (trig?.kind === "segment_entry" && trig.data.segment_id === segmentId && def.exit?.on_trigger_segment_exit && exited.length) {
      const ph = exited.map(() => "?").join(",");
      const execs = all<{ id: string; player_id: string }>(`SELECT id, player_id FROM journey_executions WHERE journey_id = ? AND status IN ('active','waiting') AND player_id IN (${ph})`, j.id, ...exited);
      for (const e of execs) {
        run("UPDATE journey_executions SET status = 'exited', exit_reason = 'left_trigger_segment', wake_at = NULL, updated_at = ? WHERE id = ?", nowIso(), e.id);
        cancelPendingMessages(e.player_id, { promotionalOnly: false, journeyId: j.id }, SYSTEM);
      }
      if (execs.length) { audit(SYSTEM, "journey.exits", "journey", j.id, { exited: execs.length, reason: "left_trigger_segment", pending_steps_cancelled: true }); publish("journeys", "journey.exited", { journey_id: j.id, exited: execs.length }, j.id); }
    }
  }
}

export function onEvent(eventName: string, playerId: string) {
  const js = all<Journey & { definition: string }>("SELECT j.*, v.definition FROM journeys j JOIN journey_versions v ON v.journey_id = j.id AND v.version = j.published_version WHERE j.status = 'active'");
  for (const j of js) {
    const trig = J.parse<JourneyDef>(j.definition, { nodes: [], edges: [] }).nodes.find((n) => n.type === "trigger");
    if (trig?.kind === "event_trigger" && trig.data.event === eventName) enroll(j.id, [playerId], `event:${eventName}`);
  }
}

/** Safety interruption: stop applicable executions immediately (overrides version pinning). */
export function stopForPlayer(playerId: string, opts: { promotionalOnly: boolean; reason: string }, actor: Actor) {
  const rows = all<{ id: string; purpose: string }>("SELECT e.id, j.purpose FROM journey_executions e JOIN journeys j ON j.id = e.journey_id WHERE e.player_id = ? AND e.status IN ('active','waiting')", playerId);
  let n = 0;
  for (const r of rows) {
    if (opts.promotionalOnly && !isPromotional(r.purpose)) continue;
    run("UPDATE journey_executions SET status = 'exited', exit_reason = ?, wake_at = NULL, updated_at = ? WHERE id = ?", opts.reason, nowIso(), r.id); n++;
  }
  if (n) audit(actor, "journey.executions_stopped", "customer", playerId, { count: n, reason: opts.reason });
  return n;
}

export function stopExecution(execId: string, actor: Actor) {
  run("UPDATE journey_executions SET status = 'exited', exit_reason = 'manually_stopped', wake_at = NULL, updated_at = ? WHERE id = ? AND status IN ('active','waiting')", nowIso(), execId);
  audit(actor, "journey.execution_stopped", "journey_execution", execId, {});
}

/** Side-effect-free simulation using real players from the trigger segment. */
export function simulate(def: JourneyDef, purpose: string, sampleSize = 200) {
  const issues = validate(def, purpose);
  const trig = def.nodes.find((n) => n.type === "trigger");
  let players: string[] = [];
  if (trig?.data.segment_id) players = all<{ player_id: string }>("SELECT player_id FROM segment_memberships WHERE segment_id = ? ORDER BY player_id LIMIT ?", trig.data.segment_id, sampleSize).map((r) => r.player_id);
  if (!players.length) players = all<{ player_id: string }>("SELECT player_id FROM customers ORDER BY player_id LIMIT ?", sampleSize).map((r) => r.player_id);
  const counts: Record<string, { entered: number; blocked: number; exited: number }> = {};
  const inc = (n: string, k: "entered" | "blocked" | "exited") => { counts[n] ??= { entered: 0, blocked: 0, exited: 0 }; counts[n][k]++; };
  for (const pid of players) {
    if (!trig) break;
    inc(trig.id, "entered");
    const queue = next(def, trig.id); let guard = 0;
    while (queue.length && guard++ < 50) {
      const nid = queue.shift(); const n = def.nodes.find((x) => x.id === nid); if (!n) continue;
      inc(n.id, "entered");
      if (n.type === "condition" || n.kind === "branch") { queue.push(...next(def, n.id, conditionHolds(n, pid, purpose) ? "yes" : "no")); continue; }
      if (n.kind === "exit_condition") { if (conditionHolds(n, pid, purpose)) { inc(n.id, "exited"); continue; } queue.push(...next(def, n.id, "no")); continue; }
      if (n.kind === "random_split" || n.kind === "ab_test") { queue.push(...next(def, n.id, bucket(`sim:${pid}:${n.id}`) < Number(n.data.percent_a ?? 50) / 100 ? "a" : "b")); continue; }
      if (n.kind === "send_message" && n.data.channel) {
        const c = evaluate({ playerIds: [pid], purpose: purpose as Purpose, channel: String(n.data.channel), action: "message", log: false })[0];
        if (!c.allowed) inc(n.id, "blocked");
      }
      if (n.kind === "end") continue;
      queue.push(...next(def, n.id));
    }
  }
  return { sample: players.length, counts, issues };
}

export function journeyStats(journeyId: string) {
  const j = getJourney(journeyId);
  const byStatus = all("SELECT status, COUNT(*) n FROM journey_executions WHERE journey_id = ? GROUP BY status", journeyId);
  const nodes = all("SELECT * FROM journey_node_stats WHERE journey_id = ? AND version = ?", journeyId, j.published_version ?? 0);
  const exits = all("SELECT exit_reason, COUNT(*) n FROM journey_executions WHERE journey_id = ? AND exit_reason IS NOT NULL GROUP BY exit_reason", journeyId);
  return { byStatus, nodes, exits };
}
export const _org = ORG_ID;
