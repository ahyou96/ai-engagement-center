import { all, db, J, one, run } from "../db";
import { audit, Actor, SYSTEM } from "../audit";
import { getActiveStrategy, getVersion, getStrategy } from "../strategy";
import { createApproval } from "../approvals";
import { HttpError, id, nowIso } from "../util";
import { publish, notify } from "../stream";
import { WORKFLOWS, workflowById, AGENTS } from "./definitions";
import { HANDLERS, GENERIC, RunCtx, AgentResult } from "./agents";

export type Run = { id: string; workflow_id: string; opportunity_id: string | null; status: string; mode: string; simulation: number; trigger: string; strategy_id: string | null; strategy_version: number | null; current_node: string | null; context: string; error: string | null; tokens: number; cost: number; replay_of: string | null; started_by: string | null; started_at: string; finished_at: string | null };
type NodeExec = { id: string; run_id: string; node_key: string; agent_key: string; status: string; attempt: number; output: string | null; summary: string | null };

const g = globalThis as unknown as { __aecDriving?: Set<string> };
const driving = g.__aecDriving ?? (g.__aecDriving = new Set());
const COST_PER_TOKEN = 0.000006; // blended estimate for display; mock mode
const delay = (ms: number) => new Promise((r) => setTimeout(r, process.env.AEC_FAST === "1" ? 0 : ms));

function emit(runId: string, type: string, payload: Record<string, unknown>) {
  publish("workflow", type, { run_id: runId, ...payload }, runId);
}

export function startRun(p: { scenario: string; mode?: "manual" | "auto"; simulation?: boolean; trigger?: string; params?: Record<string, unknown>; actor: Actor; replayOf?: string; strategyVersion?: number; injectFailure?: string }) {
  const wf = WORKFLOWS[p.scenario];
  if (!wf) throw new HttpError(404, `Unknown scenario ${p.scenario}`);
  if (one<{ value: string }>("SELECT value FROM settings WHERE key = 'emergency_stop'")?.value === "true" && !p.simulation) throw new HttpError(423, "Emergency stop is active — only simulations may run");
  // pin the latest approved+active strategy (or an explicit version for historical replay)
  let strat = getActiveStrategy(wf.strategy);
  if (p.strategyVersion != null) { const v = getVersion(strat.strategyId, p.strategyVersion); if (!v) throw new HttpError(404, "Strategy version not found"); strat = { ...strat, version: v.version, config: v.config }; }
  const runId = id("run");
  const t = nowIso();
  const ctx = { scenario: p.scenario, params: { ...(p.params ?? {}), inject_failure: p.injectFailure }, strategy: { strategyId: strat.strategyId, version: strat.version, config: strat.config }, out: {} };
  const tx = db().transaction(() => {
    run(`INSERT INTO ai_workflow_runs (id, workflow_id, status, mode, simulation, trigger, strategy_id, strategy_version, context, replay_of, started_by, started_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      runId, wf.id, "running", p.mode ?? "manual", p.simulation ? 1 : 0, p.trigger ?? "manual", strat.strategyId, strat.version, J.str(ctx), p.replayOf ?? null, p.actor.id, t, t);
    for (const n of wf.nodes) run("INSERT INTO ai_node_executions (id, run_id, node_key, agent_key, status, summary) VALUES (?,?,?,?,?,?)", id("nex"), runId, n.key, n.agent, n.applies === false ? "skipped" : "pending", n.applies === false ? n.note ?? "Not applicable" : null);
  });
  tx();
  audit(p.actor, "workflow.run_started", "workflow_run", runId, { scenario: p.scenario, mode: p.mode ?? "manual", simulation: !!p.simulation, strategy_version: strat.version, replay_of: p.replayOf });
  emit(runId, "run.started", { scenario: p.scenario, workflow: wf.name, mode: p.mode ?? "manual", simulation: !!p.simulation, strategy_version: strat.version });
  const promise = drive(runId);
  return { runId, promise };
}

/** Drive a run: execute ready nodes (parallel where dependencies allow), persist after every step. */
export async function drive(runId: string): Promise<void> {
  if (driving.has(runId)) return;
  driving.add(runId);
  try {
    for (let guard = 0; guard < 100; guard++) {
      const r = one<Run>("SELECT * FROM ai_workflow_runs WHERE id = ?", runId);
      if (!r || r.status !== "running") return;
      if (one<{ value: string }>("SELECT value FROM settings WHERE key = 'emergency_stop'")?.value === "true" && !r.simulation) { await stopRun(runId, SYSTEM, "emergency_stop"); return; }
      const wf = workflowById(r.workflow_id)![1];
      const nodes = all<NodeExec>("SELECT * FROM ai_node_executions WHERE run_id = ?", runId);
      const st = new Map(nodes.map((n) => [n.node_key, n.status]));
      // a skipped node only counts as done once its own upstream is done (keeps ordering across not-applicable nodes)
      const defOf = new Map(wf.nodes.map((n) => [n.key, n]));
      const done = (k: string): boolean => st.get(k) === "completed" || (st.get(k) === "skipped" && (defOf.get(k)?.after ?? []).every(done));
      const ready = wf.nodes.filter((n) => st.get(n.key) === "pending" && n.after.every(done));
      if (!ready.length) {
        if (nodes.some((n) => n.status === "failed")) { finish(runId, "failed"); return; }
        if (nodes.every((n) => ["completed", "skipped", "cancelled"].includes(n.status))) { finish(runId, "completed"); return; }
        return; // waiting on something else (approval, running node elsewhere)
      }
      const results = await Promise.all(ready.map((n) => execNode(runId, n.key)));
      if (results.some((x) => x === "halt" || x === "await" || x === "failed")) {
        const rr = one<Run>("SELECT status FROM ai_workflow_runs WHERE id = ?", runId)!;
        if (rr.status !== "running") return;
        if (results.includes("failed")) { finish(runId, "failed"); return; }
      }
    }
  } finally { driving.delete(runId); }
}

async function execNode(runId: string, key: string): Promise<"ok" | "halt" | "await" | "failed"> {
  const r = one<Run>("SELECT * FROM ai_workflow_runs WHERE id = ?", runId)!;
  const ctxData = J.parse<{ scenario: string; params: Record<string, unknown>; strategy: RunCtx["strategy"]; out: RunCtx["out"] }>(r.context, { scenario: "", params: {}, strategy: { strategyId: "", version: 0, config: {} }, out: {} });
  const node = one<NodeExec>("SELECT * FROM ai_node_executions WHERE run_id = ? AND node_key = ?", runId, key)!;
  const handler = GENERIC[key] ?? HANDLERS[ctxData.scenario]?.[key];
  const started = Date.now();
  run("UPDATE ai_node_executions SET status = 'running', started_at = ?, input = ? WHERE id = ?", nowIso(), J.str({ strategy_version: ctxData.strategy.version, upstream: Object.keys(ctxData.out) }), node.id);
  run("UPDATE ai_workflow_runs SET current_node = ?, updated_at = ? WHERE id = ?", key, nowIso(), runId);
  emit(runId, "node.started", { node: key, agent: AGENTS.find((a) => a.key === key)?.name, attempt: node.attempt });
  let toolTokens = 0;
  const ctx: RunCtx = {
    runId, scenario: ctxData.scenario, mode: r.mode as "manual", simulation: !!r.simulation, params: ctxData.params, strategy: ctxData.strategy, out: ctxData.out, opportunityId: r.opportunity_id,
    tool: async (name, args, fn, sum) => {
      const tid = id("tc"); const t0 = Date.now();
      emit(runId, "tool.started", { node: key, tool: name, args });
      await delay(150 + Math.floor(Math.random() * 350));
      try {
        const res = await fn();
        const s = sum ? sum(res) : "ok";
        toolTokens += Math.ceil(JSON.stringify(res ?? "").length / 8);
        run("INSERT INTO ai_tool_calls (id, run_id, node_key, tool, args, result_summary, status, duration_ms, at) VALUES (?,?,?,?,?,?,?,?,?)", tid, runId, key, name, J.str(args), s, "completed", Date.now() - t0, nowIso());
        emit(runId, "tool.completed", { node: key, tool: name, summary: s, duration_ms: Date.now() - t0 });
        return res;
      } catch (e) {
        run("INSERT INTO ai_tool_calls (id, run_id, node_key, tool, args, result_summary, status, duration_ms, at) VALUES (?,?,?,?,?,?,?,?,?)", tid, runId, key, name, J.str(args), (e as Error).message, "failed", Date.now() - t0, nowIso());
        emit(runId, "tool.failed", { node: key, tool: name, error: (e as Error).message });
        throw e;
      }
    },
  };
  let result: AgentResult;
  try {
    if (!handler) result = { summary: "No handler for this scenario — skipped", output: {} };
    else {
      if (ctxData.params.inject_failure === key && node.attempt === 1) { await delay(200); throw new Error(`Injected transient failure in ${key} (demo)`); }
      await delay(200);
      result = await handler(ctx);
    }
  } catch (e) {
    const msg = (e as Error).message;
    const attempt = node.attempt;
    run("UPDATE ai_node_executions SET status = 'failed', error = ?, finished_at = ?, duration_ms = ? WHERE id = ?", msg, nowIso(), Date.now() - started, node.id);
    emit(runId, "node.failed", { node: key, error: msg, attempt });
    if (attempt < 3 && !/Injected/.test(msg)) {
      await delay(300 * attempt);
      run("UPDATE ai_node_executions SET status = 'pending', attempt = attempt + 1 WHERE id = ?", node.id);
      emit(runId, "node.retrying", { node: key, attempt: attempt + 1 });
      return execNode(runId, key);
    }
    run("UPDATE ai_workflow_runs SET error = ?, updated_at = ? WHERE id = ?", `${key}: ${msg}`, nowIso(), runId);
    notify("workflow", "Workflow node failed", `${key}: ${msg}`, `/opportunities?run=${runId}`, "critical");
    return "failed";
  }
  const tokens = (result.tokens ?? 0) + toolTokens + Math.ceil(JSON.stringify(result.output).length / 6);
  const cost = tokens * COST_PER_TOKEN;
  // persist output into run context (outputs are trimmed to keep context small)
  const fresh = one<Run>("SELECT context FROM ai_workflow_runs WHERE id = ?", runId)!;
  const c2 = J.parse<typeof ctxData>(fresh.context, ctxData);
  c2.out[key] = result.output;
  run("UPDATE ai_workflow_runs SET context = ?, tokens = tokens + ?, cost = cost + ?, opportunity_id = COALESCE(opportunity_id, ?), updated_at = ? WHERE id = ?", J.str(c2), tokens, cost, ctx.opportunityId, nowIso(), runId);
  run("UPDATE ai_node_executions SET status = 'completed', output = ?, summary = ?, evidence = ?, confidence = ?, tokens = ?, cost = ?, finished_at = ?, duration_ms = ?, error = NULL WHERE id = ?",
    J.str(result.output), result.summary, J.str(result.evidence ?? []), result.confidence ?? null, tokens, cost, nowIso(), Date.now() - started, node.id);
  emit(runId, "node.completed", { node: key, summary: result.summary, duration_ms: Date.now() - started, tokens, confidence: result.confidence });
  if (result.halt) {
    run("UPDATE ai_node_executions SET status = 'skipped', summary = ? WHERE run_id = ? AND status = 'pending'", `Skipped: ${result.halt}`, runId);
    emit(runId, "run.halted", { node: key, reason: result.halt });
    finish(runId, "completed", result.halt);
    return "halt";
  }
  if (result.awaitApproval) {
    const decId = id("dec");
    const actions = (c2.out.decision?.actions as unknown[]) ?? [];
    const risk = (actions as Array<{ risk: string }>).some((a) => a.risk === "high") ? "high" : (actions as Array<{ risk: string }>).some((a) => a.risk === "medium") ? "medium" : "low";
    run("INSERT INTO decisions (id, run_id, opportunity_id, action_type, proposal, risk, mode, policy_result, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)", decId, runId, ctx.opportunityId, (actions[0] as { type: string })?.type ?? "action", J.str(actions), risk, r.mode, J.str(result.output), "pending", nowIso());
    const wf = workflowById(r.workflow_id)![1];
    const a = createApproval({ entityType: "workflow_decision", entityId: decId, title: `${wf.name}: ${(actions as Array<{ description?: string }>).map((x) => x.description).filter(Boolean).join("; ").slice(0, 140)}`, summary: String(c2.out.decision ? "Decision agent proposal awaiting review" : ""), evidence: [{ root_cause: c2.out.root_cause, compliance: c2.out.compliance, policy: result.output }], risk: risk as "low", requestedBy: `agent:decision` });
    run("UPDATE decisions SET approval_id = ? WHERE id = ?", a.id, decId);
    run("UPDATE ai_workflow_runs SET status = 'waiting_approval', updated_at = ? WHERE id = ?", nowIso(), runId);
    run("UPDATE ai_node_executions SET status = 'waiting', summary = ? WHERE id = ?", `${result.summary} — approval ${a.id}`, node.id);
    emit(runId, "run.waiting_approval", { node: key, approval_id: a.id, decision_id: decId });
    return "await";
  }
  return "ok";
}

function finish(runId: string, status: "completed" | "failed" | "stopped", note?: string) {
  const r = one<Run>("SELECT * FROM ai_workflow_runs WHERE id = ?", runId)!;
  if (["completed", "failed", "stopped"].includes(r.status)) return;
  run("UPDATE ai_workflow_runs SET status = ?, finished_at = ?, updated_at = ?, error = COALESCE(error, ?) WHERE id = ?", status, nowIso(), nowIso(), status === "completed" ? null : note ?? null, runId);
  if (r.opportunity_id && status === "completed" && !note) run("UPDATE opportunities SET status = 'resolved', updated_at = ? WHERE id = ?", nowIso(), r.opportunity_id);
  audit(SYSTEM, `workflow.run_${status}`, "workflow_run", runId, { note, tokens: r.tokens, cost: r.cost });
  emit(runId, "run.finished", { status, note, tokens: r.tokens, cost: r.cost });
}

/** Called by the approvals module. Approved → resume at execution; rejected → skip execution branch. */
export async function onDecisionApproval(decisionId: string, status: string, actor: Actor) {
  const d = one<{ run_id: string }>("SELECT run_id FROM decisions WHERE id = ?", decisionId);
  if (!d) return;
  run("UPDATE decisions SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?", status, actor.id, nowIso(), decisionId);
  const r = one<Run>("SELECT * FROM ai_workflow_runs WHERE id = ?", d.run_id);
  if (!r || r.status !== "waiting_approval") return;
  if (status === "approved") {
    run("UPDATE ai_node_executions SET status = 'completed', summary = summary || ' → approved by ' || ? WHERE run_id = ? AND node_key = 'approval'", actor.id, r.id);
    run("UPDATE ai_workflow_runs SET status = 'running', updated_at = ? WHERE id = ?", nowIso(), r.id);
    emit(r.id, "run.resumed", { reason: "approved", by: actor.id });
    void drive(r.id);
  } else {
    run("UPDATE ai_node_executions SET status = 'completed', summary = summary || ' → ' || ? || ' by ' || ? WHERE run_id = ? AND node_key = 'approval'", status, actor.id, r.id);
    run("UPDATE ai_node_executions SET status = 'skipped', summary = 'Skipped: proposal ' || ? WHERE run_id = ? AND status = 'pending'", status, r.id);
    run("UPDATE ai_workflow_runs SET status = 'running' WHERE id = ?", r.id);
    finish(r.id, "completed", `Proposal ${status}`);
  }
}

export function pauseRun(runId: string, actor: Actor) {
  const info = run("UPDATE ai_workflow_runs SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'running'", nowIso(), runId);
  if (!info.changes) throw new HttpError(409, "Run is not running");
  audit(actor, "workflow.paused", "workflow_run", runId, {}); emit(runId, "run.paused", { by: actor.id });
}
export function resumeRun(runId: string, actor: Actor) {
  const info = run("UPDATE ai_workflow_runs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'paused'", nowIso(), runId);
  if (!info.changes) throw new HttpError(409, "Run is not paused");
  audit(actor, "workflow.resumed", "workflow_run", runId, {}); emit(runId, "run.resumed", { by: actor.id });
  return drive(runId);
}
export async function stopRun(runId: string, actor: Actor, reason = "stopped") {
  const r = one<Run>("SELECT status FROM ai_workflow_runs WHERE id = ?", runId);
  if (!r || ["completed", "failed", "stopped"].includes(r.status)) return;
  run("UPDATE ai_node_executions SET status = 'cancelled', summary = ? WHERE run_id = ? AND status IN ('pending','waiting','running')", `Cancelled: ${reason}`, runId);
  run("UPDATE ai_workflow_runs SET status = 'running' WHERE id = ?", runId);
  finish(runId, "stopped", reason);
  run("UPDATE approvals SET status = 'cancelled', decided_at = ? WHERE status = 'pending' AND entity_type = 'workflow_decision' AND entity_id IN (SELECT id FROM decisions WHERE run_id = ?)", nowIso(), runId);
  audit(actor, "workflow.stopped", "workflow_run", runId, { reason });
}
export function retryNode(runId: string, nodeKey: string, actor: Actor) {
  const n = one<NodeExec>("SELECT * FROM ai_node_executions WHERE run_id = ? AND node_key = ?", runId, nodeKey);
  if (!n || n.status !== "failed") throw new HttpError(409, "Node is not in failed state");
  run("UPDATE ai_node_executions SET status = 'pending', attempt = attempt + 1, error = NULL WHERE id = ?", n.id);
  run("UPDATE ai_workflow_runs SET status = 'running', error = NULL, finished_at = NULL, updated_at = ? WHERE id = ?", nowIso(), runId);
  audit(actor, "workflow.node_retry", "workflow_run", runId, { node: nodeKey, attempt: n.attempt + 1 });
  emit(runId, "node.retrying", { node: nodeKey, attempt: n.attempt + 1, manual: true });
  return drive(runId);
}

export async function emergencyStop(actor: Actor, on: boolean) {
  run("INSERT OR REPLACE INTO settings (key, value, updated_by, updated_at) VALUES ('emergency_stop', ?, ?, ?)", on ? "true" : "false", actor.id, nowIso());
  let stopped = 0, journeys = 0, campaigns = 0;
  if (on) {
    for (const r of all<{ id: string }>("SELECT id FROM ai_workflow_runs WHERE status IN ('running','waiting_approval','paused') AND simulation = 0")) { await stopRun(r.id, actor, "emergency_stop"); stopped++; }
    journeys = run("UPDATE journeys SET status = 'paused', updated_at = ? WHERE status = 'active'", nowIso()).changes;
    campaigns = run("UPDATE campaigns SET status = 'paused', updated_at = ? WHERE status IN ('approved','scheduled','running')", nowIso()).changes;
  }
  audit(actor, on ? "system.emergency_stop_on" : "system.emergency_stop_off", "system", "emergency_stop", { stopped_runs: stopped, paused_journeys: journeys, paused_campaigns: campaigns });
  publish("system", "emergency_stop", { active: on, stopped_runs: stopped, paused_journeys: journeys, paused_campaigns: campaigns });
  notify("system", on ? "EMERGENCY STOP ACTIVATED" : "Emergency stop cleared", on ? `${stopped} runs stopped, ${journeys} journeys and ${campaigns} campaigns paused. Protective/security/regulatory messages remain allowed.` : "Normal operation resumed. Paused journeys must be resumed manually.", "/compliance", on ? "critical" : "success");
  return { active: on, stopped_runs: stopped, paused_journeys: journeys, paused_campaigns: campaigns };
}

/** Restart recovery: runs left 'running' after a crash resume from the last persisted node (actions are idempotent). */
export function recoverRuns() {
  const rs = all<{ id: string }>("SELECT id FROM ai_workflow_runs WHERE status = 'running'");
  for (const r of rs) {
    if (driving.has(r.id)) continue;
    run("UPDATE ai_node_executions SET status = 'pending' WHERE run_id = ? AND status = 'running'", r.id);
    emit(r.id, "run.recovered", { note: "Resumed after server restart" });
    void drive(r.id);
  }
  return rs.length;
}

export function replayRun(runId: string, actor: Actor) {
  const r = one<Run>("SELECT * FROM ai_workflow_runs WHERE id = ?", runId);
  if (!r) throw new HttpError(404, "Run not found");
  const ctx = J.parse<{ scenario: string; params: Record<string, unknown> }>(r.context, { scenario: "", params: {} });
  return startRun({ scenario: ctx.scenario, mode: r.mode as "manual", simulation: true, trigger: "historical_replay", params: ctx.params, actor, replayOf: runId, strategyVersion: r.strategy_version ?? undefined });
}

export function runDetail(runId: string) {
  const r = one<Run>("SELECT * FROM ai_workflow_runs WHERE id = ?", runId);
  if (!r) throw new HttpError(404, "Run not found");
  const nodes = all<Record<string, unknown>>("SELECT id, node_key, agent_key, status, attempt, summary, evidence, error, confidence, tokens, cost, started_at, finished_at, duration_ms, output, input FROM ai_node_executions WHERE run_id = ?", runId)
    .map((n) => ({ ...n, evidence: J.parse<unknown[]>(n.evidence, []), output: J.parse<unknown>(n.output, null), input: J.parse<unknown>(n.input, null) }) as unknown as Record<string, unknown> & { node_key: string; status: string; summary: string | null; duration_ms: number | null });
  const tools = all("SELECT * FROM ai_tool_calls WHERE run_id = ? ORDER BY at", runId);
  const decisions = all("SELECT * FROM decisions WHERE run_id = ?", runId);
  const wf = workflowById(r.workflow_id)!;
  const strategy = r.strategy_id ? one<{ name: string; category: string }>("SELECT name, category FROM strategies WHERE id = ?", r.strategy_id) : null;
  const { context, ...rest } = r;
  return { run: { ...rest, params: J.parse<{ params: unknown }>(context, { params: {} }).params }, workflow: { id: wf[1].id, scenario: wf[0], name: wf[1].name, nodes: wf[1].nodes }, nodes, tools, decisions, strategy };
}

export function compareRuns(a: string, b: string) {
  const A = runDetail(a), B = runDetail(b);
  return { a: A, b: B, diff: A.workflow.nodes.map((n) => {
    const x = A.nodes.find((m) => m.node_key === n.key), y = B.nodes.find((m) => m.node_key === n.key);
    return { node: n.key, a: { status: x?.status, summary: x?.summary, duration: x?.duration_ms }, b: { status: y?.status, summary: y?.summary, duration: y?.duration_ms } };
  }) };
}
export { getStrategy };
