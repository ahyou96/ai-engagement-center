import { z } from "zod";
import { all, db, J, one, run, tx } from "./db";
import { audit, Actor, SYSTEM } from "./audit";
import { evaluatePlayer, isPromoPurpose } from "./segments";
import { cancelPendingMessages } from "./messaging";
import { cancelOpenEntitlements } from "./offers";
import { getActiveStrategy } from "./strategy";
import { HttpError, id, nowIso, ORG_ID, daysAgo } from "./util";
import { publish, notify } from "./stream";
import { maskRecord, can } from "./rbac";
import { stopForPlayer, onEvent as journeyOnEvent } from "./journeys";

export const EventSchema = z.object({
  event_id: z.string().min(6).max(80),
  event_name: z.string().min(2).max(60),
  player_id: z.string().max(40).optional().nullable(),
  game_id: z.string().max(40).optional().nullable(),
  provider_id: z.string().max(40).optional().nullable(),
  session_id: z.string().max(60).optional().nullable(),
  event_time: z.string().datetime().optional(),
  entry_source: z.string().max(40).optional().nullable(),
  platform: z.enum(["app", "h5", "pc"]).optional().nullable(),
  device_type: z.string().max(20).optional().nullable(),
  operating_system: z.string().max(20).optional().nullable(),
  app_version: z.string().max(20).optional().nullable(),
  loading_duration: z.number().int().min(0).max(600000).optional().nullable(),
  error_code: z.string().max(60).optional().nullable(),
  correlation_id: z.string().max(80).optional().nullable(),
  properties: z.record(z.unknown()).optional(),
  schema_version: z.number().int().optional(),
});
export type IngestEvent = z.infer<typeof EventSchema>;

/** Validate → dictionary check → dedupe → persist → update profile → realtime segments → journeys → protective handling. */
export function ingestEvents(raw: unknown[], source = "api", actor: Actor = { type: "api", id: "ingest" }) {
  const result = { accepted: 0, duplicates: 0, rejected: 0, errors: [] as Array<{ event_id?: string; reason: string }> };
  const defs = new Map(all<{ name: string; category: string; required_attributes: string; enabled: number; version: number }>("SELECT * FROM event_definitions").map((d) => [d.name, d]));
  const touched = new Map<string, Set<string>>();
  const ins = db().prepare(`INSERT OR IGNORE INTO events (event_id, org_id, event_name, category, schema_version, player_id, game_id, provider_id, session_id, event_time, entry_source, platform, device_type, operating_system, app_version, loading_duration, error_code, correlation_id, properties, source, ingested_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const rej = db().prepare("INSERT INTO event_rejections (event_id, event_name, reason, payload, at) VALUES (?,?,?,?,?)");
  tx(() => {
    for (const r of raw) {
      const p = EventSchema.safeParse(r);
      const eid = (r as { event_id?: string })?.event_id;
      if (!p.success) { result.rejected++; const reason = p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "); result.errors.push({ event_id: eid, reason }); rej.run(eid ?? null, (r as { event_name?: string })?.event_name ?? null, reason, J.str(r), nowIso()); continue; }
      const e = p.data;
      const def = defs.get(e.event_name);
      if (!def || !def.enabled) { result.rejected++; result.errors.push({ event_id: e.event_id, reason: `Unknown or disabled event ${e.event_name}` }); rej.run(e.event_id, e.event_name, "unknown_event", J.str(r), nowIso()); continue; }
      const missing = J.parse<string[]>(def.required_attributes, []).filter((a) => (e as Record<string, unknown>)[a] == null);
      if (missing.length) { result.rejected++; result.errors.push({ event_id: e.event_id, reason: `Missing ${missing.join(", ")}` }); rej.run(e.event_id, e.event_name, `missing:${missing.join(",")}`, J.str(r), nowIso()); continue; }
      if (e.player_id && !one("SELECT 1 FROM customers WHERE player_id = ?", e.player_id)) { result.rejected++; result.errors.push({ event_id: e.event_id, reason: "Unknown player_id" }); rej.run(e.event_id, e.event_name, "unknown_player", J.str(r), nowIso()); continue; }
      const info = ins.run(e.event_id, ORG_ID, e.event_name, def.category, e.schema_version ?? def.version, e.player_id ?? null, e.game_id ?? null, e.provider_id ?? null, e.session_id ?? null, e.event_time ?? nowIso(),
        e.entry_source ?? null, e.platform ?? null, e.device_type ?? null, e.operating_system ?? null, e.app_version ?? null, e.loading_duration ?? null, e.error_code ?? null, e.correlation_id ?? null, J.str(e.properties ?? {}), source, nowIso());
      if (info.changes === 0) { result.duplicates++; continue; }
      result.accepted++;
      if (e.player_id) { const s = touched.get(e.player_id) ?? new Set(); s.add(e.event_name); touched.set(e.player_id, s); }
    }
  });
  for (const [pid, names] of touched) {
    refreshAggregates(pid);
    if (names.has("self_exclusion_enabled")) applyProtection(pid, "self_exclusion", "self_exclusion_enabled event", actor);
    if (names.has("gaming_limit_reached")) applyProtection(pid, "rg_restriction", "gaming_limit_reached event", actor);
    if (names.has("kyc_verified")) setAttribute(pid, "kyc_status", "verified", "event:kyc_verified");
    if (names.has("kyc_failed")) setAttribute(pid, "kyc_status", "failed", "event:kyc_failed");
    if (names.has("kyc_submitted")) setAttribute(pid, "kyc_status", "in_review", "event:kyc_submitted");
    evaluatePlayer(pid, `event:${[...names].join(",")}`);
    for (const n of names) journeyOnEvent(n, pid);
  }
  if (result.accepted) publish("events", "events.ingested", { accepted: result.accepted, duplicates: result.duplicates, rejected: result.rejected, players: touched.size });
  return result;
}

/** Recompute experience aggregates for one player from raw events (7-day windows). */
export function refreshAggregates(pid: string) {
  const since = daysAgo(7);
  const a = one<{ ok: number; fail: number; load: number | null; nores: number; last: string | null }>(`SELECT
    SUM(CASE WHEN event_name = 'game_launch_success' THEN 1 ELSE 0 END) ok,
    SUM(CASE WHEN event_name = 'game_launch_failed' THEN 1 ELSE 0 END) fail,
    AVG(CASE WHEN event_name IN ('game_launch_success','game_launch_failed') THEN loading_duration END) load,
    SUM(CASE WHEN event_name = 'game_search_no_result' THEN 1 ELSE 0 END) nores,
    MAX(event_time) last FROM events WHERE player_id = ? AND event_time >= ?`, pid, since)!;
  run("UPDATE customers SET launch_success_7d = ?, launch_failures_7d = ?, avg_load_ms = COALESCE(?, avg_load_ms), search_no_result_7d = ?, last_active_at = MAX(COALESCE(last_active_at,''), COALESCE(?, '')), updated_at = ? WHERE player_id = ?",
    a.ok ?? 0, a.fail ?? 0, a.load == null ? null : Math.round(a.load), a.nores ?? 0, a.last, nowIso(), pid);
}

export function setAttribute(pid: string, attr: string, value: string | number, source: string) {
  const allowed = ["kyc_status", "lifecycle_stage", "vip_tier", "account_status", "marketing_opt_out", "self_excluded", "rg_restricted", "language"];
  if (!allowed.includes(attr)) throw new HttpError(400, `Attribute ${attr} cannot be set`);
  const old = one<Record<string, unknown>>(`SELECT ${attr} v FROM customers WHERE player_id = ?`, pid);
  if (!old) throw new HttpError(404, "Player not found");
  if (String(old.v) === String(value)) return;
  run(`UPDATE customers SET ${attr} = ?, updated_at = ?${attr === "kyc_status" ? ", kyc_updated_at = ?" : ""} WHERE player_id = ?`, value, nowIso(), ...(attr === "kyc_status" ? [nowIso()] : []), pid);
  run("INSERT INTO customer_attribute_history (player_id, attribute, old_value, new_value, source, changed_at) VALUES (?,?,?,?,?,?)", pid, attr, String(old.v), String(value), source, nowIso());
}

/**
 * Scenario E — responsible gaming protection. Immediate, non-bypassable:
 * profile flags → exclusion record → compliance tag → leave promotional segments → stop promo journeys →
 * cancel queued promo messages + unclaimed entitlements → optional protective service task → full audit.
 */
export function applyProtection(pid: string, type: "self_exclusion" | "rg_restriction", reason: string, actor: Actor = SYSTEM) {
  const started = Date.now();
  const strat = getActiveStrategy("rg_protection");
  const cfg = strat.config as { create_protective_task?: boolean };
  const steps: Array<{ step: string; result: unknown }> = [];
  setAttribute(pid, type === "self_exclusion" ? "self_excluded" : "rg_restricted", 1, reason);
  steps.push({ step: "profile_updated", result: type });
  if (!one("SELECT 1 FROM exclusion_records WHERE player_id = ? AND exclusion_type = ? AND active = 1", pid, type)) {
    run("INSERT INTO exclusion_records (id, player_id, exclusion_type, reason, source, active, created_at) VALUES (?,?,?,?,?,1,?)", id("exc"), pid, type, reason, actor.id, nowIso());
  }
  steps.push({ step: "exclusion_recorded", result: true });
  const tag = one<{ id: string }>("SELECT id FROM tags WHERE key = 'rg_excluded'");
  if (tag) run("INSERT OR IGNORE INTO customer_tags (player_id, tag_id, source, added_at) VALUES (?,?,?,?)", pid, tag.id, "compliance", nowIso());
  steps.push({ step: "compliance_tag_applied", result: "rg_excluded" });
  const promoSegs = all<{ id: string; purpose: string }>("SELECT s.id, s.purpose FROM segments s JOIN segment_memberships m ON m.segment_id = s.id WHERE m.player_id = ?", pid).filter((s) => isPromoPurpose(s.purpose));
  for (const s of promoSegs) {
    run("DELETE FROM segment_memberships WHERE segment_id = ? AND player_id = ?", s.id, pid);
    run("INSERT INTO segment_membership_history (segment_id, player_id, action, reason, at) VALUES (?,?,?,?,?)", s.id, pid, "exit", `compliance:${type}`, nowIso());
    run("UPDATE segments SET member_count = member_count - 1 WHERE id = ?", s.id);
  }
  steps.push({ step: "removed_from_promotional_segments", result: promoSegs.length });
  const journeysStopped = stopForPlayer(pid, { promotionalOnly: true, reason: `compliance:${type}` }, actor);
  steps.push({ step: "promotional_journeys_stopped", result: journeysStopped });
  steps.push({ step: "queued_promotional_messages_cancelled", result: cancelPendingMessages(pid, { promotionalOnly: true }, actor) });
  steps.push({ step: "unclaimed_entitlements_cancelled", result: cancelOpenEntitlements(pid, actor) });
  if (cfg.create_protective_task) {
    const tid = id("tkt");
    run("INSERT INTO service_tickets (id, player_id, category, subject, status, priority, source, created_at) VALUES (?,?,?,?,?,?,?,?)", tid, pid, "responsible_gaming", "Protective outreach: confirm support resources were offered", "open", "high", "compliance", nowIso());
    steps.push({ step: "protective_task_created", result: tid });
  }
  const latencyMs = Date.now() - started;
  audit(actor, "compliance.protection_applied", "customer", pid, { type, reason, steps, latency_ms: latencyMs, strategy_version: strat.version });
  publish("compliance", "compliance.protection_applied", { player_id: pid, type, steps, latency_ms: latencyMs }, pid);
  notify("compliance", "Responsible gaming protection applied", `${pid}: ${type.replace("_", " ")} — promotional activity stopped`, `/audience/${pid}`, "warning");
  return { steps, latencyMs };
}

// ───── identity resolution ─────
export function resolveIdentity(type: string, value: string) {
  const r = one<{ player_id: string; verified: number }>("SELECT player_id, verified FROM customer_identities WHERE identity_type = ? AND identity_value = ?", type, value);
  return r ?? null;
}
/** Only verified identifiers link automatically; anything uncertain becomes a merge candidate for human review. */
export function linkIdentity(p: { player_id: string; type: string; value: string; verified: boolean; source: string; confidence?: number }, actor: Actor) {
  const existing = one<{ player_id: string; verified: number }>("SELECT player_id, verified FROM customer_identities WHERE identity_type = ? AND identity_value = ?", p.type, p.value);
  if (existing && existing.player_id === p.player_id) return { status: "already_linked" };
  if (existing || !p.verified || (p.confidence ?? 1) < 0.99) {
    const cid = id("imc");
    run("INSERT INTO identity_merge_candidates (id, org_id, identity_type, identity_value, candidate_player_id, matched_player_id, match_reason, confidence, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      cid, ORG_ID, p.type, p.value, p.player_id, existing?.player_id ?? null, existing ? "identifier already linked to another player" : "unverified identifier", p.confidence ?? 0.5, "pending", nowIso());
    audit(actor, "identity.merge_candidate", "customer", p.player_id, { type: p.type, conflict_with: existing?.player_id });
    return { status: "pending_review", candidate_id: cid };
  }
  run("INSERT INTO customer_identities (id, org_id, player_id, identity_type, identity_value, verified, confidence, source, created_at) VALUES (?,?,?,?,?,1,1,?,?)", id("idn"), ORG_ID, p.player_id, p.type, p.value, p.source, nowIso());
  audit(actor, "identity.linked", "customer", p.player_id, { type: p.type, source: p.source });
  return { status: "linked" };
}
export function decideMergeCandidate(cid: string, approve: boolean, actor: Actor) {
  const c = one<{ id: string; identity_type: string; identity_value: string; candidate_player_id: string; matched_player_id: string | null; status: string }>("SELECT * FROM identity_merge_candidates WHERE id = ?", cid);
  if (!c || c.status !== "pending") throw new HttpError(409, "Candidate not pending");
  tx(() => {
    if (approve) {
      if (c.matched_player_id) run("DELETE FROM customer_identities WHERE identity_type = ? AND identity_value = ?", c.identity_type, c.identity_value);
      run("INSERT INTO customer_identities (id, org_id, player_id, identity_type, identity_value, verified, confidence, source, created_at) VALUES (?,?,?,?,?,1,1,?,?)", id("idn"), ORG_ID, c.candidate_player_id, c.identity_type, c.identity_value, `manual_review:${actor.id}`, nowIso());
    }
    run("UPDATE identity_merge_candidates SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?", approve ? "approved" : "rejected", actor.id, nowIso(), cid);
  });
  audit(actor, approve ? "identity.merge_approved" : "identity.merge_rejected", "customer", c.candidate_player_id, { candidate: cid, type: c.identity_type });
}

// ───── Customer 360 ─────
export function customer360(pid: string, role: string) {
  const c = one<Record<string, unknown>>("SELECT * FROM customers WHERE player_id = ?", pid);
  if (!c) throw new HttpError(404, "Customer not found");
  const masked = maskRecord(role, c);
  const identities = all<Record<string, unknown>>("SELECT identity_type, identity_value, verified, source, created_at FROM customer_identities WHERE player_id = ?", pid)
    .map((i) => ({ ...i, identity_value: can(role, "pii.read") ? i.identity_value : String(i.identity_value).slice(0, 3) + "•••" }));
  const tags = all("SELECT t.key, t.name, t.tag_type, ct.source, ct.added_at, ct.expires_at FROM customer_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.player_id = ?", pid);
  const segments = all("SELECT s.id, s.name, s.purpose, m.joined_at FROM segment_memberships m JOIN segments s ON s.id = m.segment_id WHERE m.player_id = ?", pid);
  const segmentHistory = all("SELECT h.*, s.name FROM segment_membership_history h JOIN segments s ON s.id = h.segment_id WHERE h.player_id = ? ORDER BY h.id DESC LIMIT 30", pid);
  const attrHistory = all("SELECT * FROM customer_attribute_history WHERE player_id = ? ORDER BY id DESC LIMIT 50", pid);
  const timeline = all("SELECT event_id, event_name, category, event_time, game_id, provider_id, platform, entry_source, loading_duration, error_code FROM events WHERE player_id = ? ORDER BY event_time DESC LIMIT 60", pid);
  const consents = all("SELECT channel, purpose, granted, updated_at FROM consent_current WHERE player_id = ?", pid);
  const exclusions = all("SELECT * FROM exclusion_records WHERE player_id = ? ORDER BY created_at DESC", pid);
  const offers = all("SELECT t.id, t.status, t.amount, t.created_at, t.expires_at, o.name, o.category FROM offer_transactions t JOIN offers o ON o.id = t.offer_id WHERE t.player_id = ? ORDER BY t.created_at DESC", pid);
  const messages = all("SELECT id, channel, purpose, status, created_at, body_preview FROM messages WHERE player_id = ? ORDER BY created_at DESC LIMIT 30", pid);
  const tickets = all("SELECT * FROM service_tickets WHERE player_id = ? ORDER BY created_at DESC LIMIT 20", pid);
  const sessions = all("SELECT s.*, g.name game_name, g.category FROM gaming_sessions s JOIN games g ON g.id = s.game_id WHERE s.player_id = ? ORDER BY started_at DESC LIMIT 20", pid);
  const gamePrefs = all("SELECT g.category, COUNT(*) n FROM gaming_sessions s JOIN games g ON g.id = s.game_id WHERE s.player_id = ? GROUP BY g.category ORDER BY n DESC", pid);
  const providers = all("SELECT p.name, COUNT(*) n FROM gaming_sessions s JOIN gaming_providers p ON p.id = s.provider_id WHERE s.player_id = ? GROUP BY p.name ORDER BY n DESC LIMIT 5", pid);
  const entrySources = all("SELECT entry_source, COUNT(*) n FROM events WHERE player_id = ? AND event_name = 'game_click' GROUP BY entry_source ORDER BY n DESC", pid);
  const searches = all("SELECT json_extract(properties,'$.keyword') keyword, event_name, event_time FROM events WHERE player_id = ? AND event_name IN ('game_search','game_search_no_result') ORDER BY event_time DESC LIMIT 10", pid);
  const restrictedTx = can(role, "gaming_transactions.read")
    ? { access: "granted", purpose_notice: "Restricted: accounting, fraud, compliance & responsible gaming use only", rows: all("SELECT * FROM gaming_transactions WHERE player_id = ? ORDER BY settled_at DESC LIMIT 20", pid) }
    : { access: "denied", purpose_notice: "Requires gaming_transactions.read (accounting / compliance roles)", rows: [] };
  const completeness = Number(c.profile_completeness ?? 0);
  const summary = serviceSummary(c, tickets.length, exclusions.length);
  return { profile: masked, identities, tags, segments, segmentHistory, attrHistory, timeline, consents, exclusions, offers, messages, tickets, sessions, gamePrefs, providers, entrySources, searches, restrictedTx, completeness, summary };
}

function serviceSummary(c: Record<string, unknown>, tickets: number, exclusions: number) {
  const parts: string[] = [];
  parts.push(`${c.vip_tier} member on ${c.primary_platform} (${c.os}), lifecycle ${c.lifecycle_stage}.`);
  if (c.kyc_status !== "verified") parts.push(`KYC is ${c.kyc_status}${c.kyc_failure_reason ? ` (${c.kyc_failure_reason})` : ""} — may need verification help.`);
  if (Number(c.launch_failures_7d) > 0) parts.push(`${c.launch_failures_7d} failed game launches in 7 days (avg load ${c.avg_load_ms} ms) — likely experience issue.`);
  if (Number(c.open_tickets) > 0) parts.push(`${c.open_tickets} open service ticket(s).`);
  if (Number(c.search_no_result_7d) > 0) parts.push(`${c.search_no_result_7d} searches returned no results.`);
  if (exclusions || c.self_excluded || c.rg_restricted) parts.push("⚠ Responsible gaming / exclusion in effect — service & protective contact only; no promotions.");
  if (!tickets && !Number(c.launch_failures_7d)) parts.push("No recent service issues.");
  return { text: parts.join(" "), generated_by: "deterministic summarizer (mock AI)", note: "Service-oriented summary; does not use wagering or loss data." };
}
