import { z } from "zod";
import { all, J, one, run } from "./db";
import { currentUser, login, logout, SessionUser, actorOf, hashPassword } from "./auth";
import { can, Permission, ROLES, PERMISSIONS } from "./rbac";
import { HttpError, id, nowIso, ORG_ID, hashStable } from "./util";
import { body, rateLimit } from "./api";
import { audit, verifyAuditChain } from "./audit";
import { sseResponse, notify } from "./stream";
import * as M from "./metrics";
import * as SEG from "./segments";
import * as CDP from "./cdp";
import * as OFF from "./offers";
import * as CMP from "./campaigns";
import * as JRN from "./journeys";
import * as MSG from "./messaging";
import * as STR from "./strategy";
import * as WF from "./workflow/engine";
import { AGENTS, WORKFLOWS } from "./workflow/definitions";
import { decide, history as approvalHistory, expireApprovals } from "./approvals";
import { evaluate, policies, validateContent, summarize } from "./compliance";
import { copilotTurn, Part, parseSegment } from "./ai/copilot";
import { providerStatus, activeProvider } from "./ai/provider";

/**
 * Single documented API router (see docs/API.md). Every route declares its permission;
 * mutating cookie-authenticated requests must be same-origin (CSRF); all inputs are zod-validated.
 */
type Ctx = { req: Request; url: URL; params: Record<string, string>; user: SessionUser };
type Route = { method: string; pattern: string; perm?: Permission | null; public?: boolean; handler: (c: Ctx) => Promise<unknown> | unknown };
const routes: Route[] = [];
const r = (method: string, pattern: string, perm: Permission | null, handler: Route["handler"], pub = false) => routes.push({ method, pattern, perm, handler, public: pub });

const pageArgs = (u: URL) => ({ limit: Math.min(200, Number(u.searchParams.get("limit") ?? 50)), offset: Number(u.searchParams.get("offset") ?? 0) });

// ───────── auth ─────────
r("POST", "auth/login", null, async ({ req }) => {
  const b = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(await body(req));
  rateLimit(`login:${b.email}`, 10);
  rateLimit(`login-ip:${(req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim()}`, 20);
  const u = await login(b.email, b.password);
  if (!u) throw new HttpError(401, "Invalid email or password");
  audit({ type: "user", id: u.email }, "auth.login", "user", u.id, {});
  return { ok: true, user: { email: u.email, name: u.name, role: u.role_id } };
}, true);
r("POST", "auth/logout", null, async ({ user }) => { await logout(); audit(actorOf(user), "auth.logout", "user", user.id, {}); return { ok: true }; });
r("GET", "auth/me", null, ({ user }) => ({ ...user, permissions: ROLES[user.role_id]?.permissions ?? [], emergency_stop: one<{ value: string }>("SELECT value FROM settings WHERE key = 'emergency_stop'")?.value === "true", ai_provider: activeProvider() }));
r("GET", "auth/config", null, () => ({ demo_logins: process.env.AEC_PUBLIC !== "1" }), true);
r("GET", "health", null, () => ({ ok: true, db: !!one("SELECT 1 x"), time: nowIso(), audit_chain: verifyAuditChain().ok }), true);

// ───────── realtime ─────────
r("GET", "stream", "dashboard.read", ({ req, url }) => sseResponse(req, { topics: url.searchParams.get("topics")?.split(",").filter(Boolean) }));
r("GET", "notifications", "dashboard.read", () => ({ items: all("SELECT * FROM notifications ORDER BY id DESC LIMIT 40"), unread: one<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE read = 0")!.n }));
r("POST", "notifications/read", "dashboard.read", () => { run("UPDATE notifications SET read = 1 WHERE read = 0"); return { ok: true }; });

// ───────── overview / search ─────────
r("GET", "overview", "dashboard.read", ({ url }) => M.overview(M.parseFilters(url.searchParams)));
r("GET", "filters", "dashboard.read", () => ({ providers: all("SELECT id, name FROM gaming_providers ORDER BY name"), channels: all("SELECT key, name FROM channels"), segments: all("SELECT id, name, purpose FROM segments ORDER BY name"), campaigns: all("SELECT id, name FROM campaigns ORDER BY created_at DESC") }));
r("GET", "search", "dashboard.read", ({ url, user }) => {
  const q = `%${(url.searchParams.get("q") ?? "").trim()}%`;
  if (q.length < 4) return { results: [] };
  const pii = can(user.role_id, "pii.read");
  return { results: [
    ...all<{ id: string; label: string }>(`SELECT player_id id, player_id || ' · ' || ${pii ? "display_name" : "'(masked)'"} label FROM customers WHERE player_id LIKE ? ${pii ? "OR display_name LIKE ?" : ""} LIMIT 6`, q, ...(pii ? [q] : [])).map((x) => ({ ...x, type: "customer", href: `/audience/${x.id}` })),
    ...all<{ id: string; label: string }>("SELECT id, name label FROM segments WHERE name LIKE ? LIMIT 5", q).map((x) => ({ ...x, type: "segment", href: `/audience?tab=segments&id=${x.id}` })),
    ...all<{ id: string; label: string }>("SELECT id, name label FROM campaigns WHERE name LIKE ? LIMIT 5", q).map((x) => ({ ...x, type: "campaign", href: `/campaigns?id=${x.id}` })),
    ...all<{ id: string; label: string }>("SELECT id, name label FROM journeys WHERE name LIKE ? LIMIT 5", q).map((x) => ({ ...x, type: "journey", href: `/journeys/${x.id}` })),
    ...all<{ id: string; label: string }>("SELECT id, title label FROM opportunities WHERE title LIKE ? ORDER BY detected_at DESC LIMIT 5", q).map((x) => ({ ...x, type: "opportunity", href: `/opportunities?opp=${x.id}` })),
    ...all<{ id: string; label: string }>("SELECT id, name label FROM offers WHERE name LIKE ? LIMIT 4", q).map((x) => ({ ...x, type: "offer", href: `/offers?id=${x.id}` })),
  ] };
});

// ───────── copilot ─────────
r("POST", "copilot/chat", "copilot.use", async ({ req, user }) => {
  rateLimit(`copilot:${user.id}`, 30);
  const b = z.object({ message: z.string().min(1).max(4000), conversation_id: z.string().optional() }).parse(await body(req));
  const enc = new TextEncoder();
  const ctrl = new AbortController();
  req.signal.addEventListener("abort", () => ctrl.abort());
  let seq = 0;
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (p: Part) => { try { controller.enqueue(enc.encode(`id: ${++seq}\nevent: ${p.type}\ndata: ${JSON.stringify(p)}\n\n`)); } catch { ctrl.abort(); } };
      await copilotTurn({ user, message: b.message, conversationId: b.conversation_id, signal: ctrl.signal, emit });
      try { controller.close(); } catch { /* closed */ }
    },
    cancel() { ctrl.abort(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
});
r("GET", "copilot/conversations", "copilot.use", ({ user }) => all("SELECT * FROM copilot_conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50", user.id));
r("GET", "copilot/conversations/:id", "copilot.use", ({ params, user }) => {
  const c = one("SELECT * FROM copilot_conversations WHERE id = ? AND user_id = ?", params.id, user.id);
  if (!c) throw new HttpError(404, "Conversation not found");
  return { conversation: c, messages: all<Record<string, unknown>>("SELECT * FROM copilot_messages WHERE conversation_id = ? ORDER BY created_at", params.id).map((m) => ({ ...m, parts: J.parse(m.parts, []) })) };
});
r("DELETE", "copilot/conversations/:id", "copilot.use", ({ params, user }) => { run("DELETE FROM copilot_messages WHERE conversation_id IN (SELECT id FROM copilot_conversations WHERE id = ? AND user_id = ?)", params.id, user.id); run("DELETE FROM copilot_conversations WHERE id = ? AND user_id = ?", params.id, user.id); return { ok: true }; });

// ───────── opportunities & workflows ─────────
r("GET", "opportunities", "opportunities.read", ({ url }) => {
  const st = url.searchParams.get("status"); const sev = url.searchParams.get("severity"); const cat = url.searchParams.get("category");
  const w = ["1=1"]; const p: unknown[] = [];
  if (st) { w.push("status = ?"); p.push(st); } if (sev) { w.push("severity = ?"); p.push(sev); } if (cat) { w.push("category = ?"); p.push(cat); }
  return all<Record<string, unknown>>(`SELECT * FROM opportunities WHERE ${w.join(" AND ")} ORDER BY detected_at DESC LIMIT 200`, ...p).map((o) => ({ ...o, evidence: J.parse(o.evidence, []), affected_systems: J.parse(o.affected_systems, []), possible_causes: J.parse(o.possible_causes, []), recommended_actions: J.parse(o.recommended_actions, []) }));
});
r("POST", "opportunities/:id", "workflows.control", async ({ req, params, user }) => {
  const b = z.object({ status: z.enum(["new", "in_progress", "resolved", "dismissed"]) }).parse(await body(req));
  run("UPDATE opportunities SET status = ?, updated_at = ? WHERE id = ?", b.status, nowIso(), params.id);
  audit(actorOf(user), "opportunity.status", "opportunity", params.id, b);
  return { ok: true };
});
r("GET", "workflows", "opportunities.read", () => ({
  workflows: Object.entries(WORKFLOWS).map(([k, w]) => ({ scenario: k, ...w, active_strategy: (() => { try { return STR.getActiveStrategy(w.strategy).version; } catch { return null; } })() })),
  agents: all<Record<string, unknown>>("SELECT * FROM ai_agents").map((a) => ({ ...a, allowed_tools: J.parse(a.allowed_tools, []) })),
  runs: all("SELECT r.id, r.workflow_id, w.name, w.scenario, r.status, r.mode, r.simulation, r.trigger, r.strategy_version, r.current_node, r.tokens, r.cost, r.error, r.started_by, r.started_at, r.finished_at, r.replay_of, r.opportunity_id FROM ai_workflow_runs r JOIN ai_workflows w ON w.id = r.workflow_id ORDER BY r.started_at DESC LIMIT 100"),
  definitions: AGENTS,
  emergency_stop: one<{ value: string }>("SELECT value FROM settings WHERE key = 'emergency_stop'")?.value === "true",
}));
r("POST", "workflows/run", "workflows.run", async ({ req, user }) => {
  const b = z.object({ scenario: z.string(), mode: z.enum(["manual", "auto"]).default("manual"), simulation: z.boolean().default(false), inject_failure: z.string().optional(), params: z.record(z.unknown()).optional(), schedule_minutes: z.number().int().min(1).max(1440).optional() }).parse(await body(req));
  if (b.mode === "auto" && !can(user.role_id, "workflows.control")) throw new HttpError(403, "Automatic mode requires workflows.control");
  if (b.schedule_minutes) {
    const due = new Date(Date.now() + b.schedule_minutes * 60000).toISOString();
    const sched = J.parse<Array<Record<string, unknown>>>(one<{ value: string }>("SELECT value FROM settings WHERE key = 'scheduled_runs'")?.value, []);
    sched.push({ id: id("sch"), scenario: b.scenario, mode: b.mode, simulation: b.simulation, due, by: user.email });
    run("INSERT OR REPLACE INTO settings (key, value, updated_by, updated_at) VALUES ('scheduled_runs', ?, ?, ?)", J.str(sched), user.email, nowIso());
    audit(actorOf(user), "workflow.scheduled", "workflow", b.scenario, { due });
    return { scheduled: true, due };
  }
  const { runId } = WF.startRun({ scenario: b.scenario, mode: b.mode, simulation: b.simulation, trigger: "manual", params: b.params, actor: actorOf(user), injectFailure: b.inject_failure });
  return { run_id: runId };
});
r("GET", "workflows/runs/:id", "opportunities.read", ({ params }) => WF.runDetail(params.id));
r("GET", "workflows/runs/:id/stream", "opportunities.read", ({ req, params }) => sseResponse(req, { topics: ["workflow"], refId: params.id }));
r("POST", "workflows/runs/:id/control", "workflows.control", async ({ req, params, user }) => {
  const b = z.object({ action: z.enum(["pause", "resume", "stop", "retry", "replay"]), node: z.string().optional() }).parse(await body(req));
  const a = actorOf(user);
  switch (b.action) {
    case "pause": WF.pauseRun(params.id, a); break;
    case "resume": void WF.resumeRun(params.id, a); break;
    case "stop": await WF.stopRun(params.id, a, "manual stop"); break;
    case "retry": if (!b.node) throw new HttpError(400, "node required"); void WF.retryNode(params.id, b.node, a); break;
    case "replay": return { run_id: WF.replayRun(params.id, a).runId };
  }
  return { ok: true };
});
r("POST", "workflows/decisions/:id", "approvals.decide", async ({ req, params, user }) => {
  // human intervention: edit the proposed actions before approving
  const b = z.object({ actions: z.array(z.object({ type: z.string(), risk: z.enum(["low", "medium", "high"]), description: z.string().optional(), purpose: z.string().optional(), audience: z.number().optional() })) }).parse(await body(req));
  const d = one<{ status: string }>("SELECT status FROM decisions WHERE id = ?", params.id);
  if (!d || d.status !== "pending") throw new HttpError(409, "Decision is not pending");
  run("UPDATE decisions SET proposal = ? WHERE id = ?", J.str(b.actions), params.id);
  audit(actorOf(user), "decision.modified", "decision", params.id, { actions: b.actions.map((x) => x.type) });
  return { ok: true };
});
r("GET", "workflows/compare", "opportunities.read", ({ url }) => WF.compareRuns(url.searchParams.get("a") ?? "", url.searchParams.get("b") ?? ""));
r("POST", "system/emergency-stop", "workflows.emergency_stop", async ({ req, user }) => {
  const b = z.object({ on: z.boolean() }).parse(await body(req));
  return WF.emergencyStop(actorOf(user), b.on);
});

// ───────── audience / CDP ─────────
r("GET", "customers", "audience.read", ({ url, user }) => {
  const sp = url.searchParams; const { limit, offset } = pageArgs(url);
  const w = ["1=1"]; const p: unknown[] = [];
  const q = sp.get("q"); if (q) { w.push(can(user.role_id, "pii.read") ? "(player_id LIKE ? OR display_name LIKE ? OR email LIKE ?)" : "player_id LIKE ?"); p.push(...(can(user.role_id, "pii.read") ? [`%${q}%`, `%${q}%`, `%${q}%`] : [`%${q}%`])); }
  for (const k of ["lifecycle_stage", "kyc_status", "vip_tier", "primary_platform", "os"]) { const v = sp.get(k); if (v) { w.push(`${k} = ?`); p.push(v); } }
  const seg = sp.get("segment"); if (seg) { w.push("player_id IN (SELECT player_id FROM segment_memberships WHERE segment_id = ?)"); p.push(seg); }
  const sort = ["last_active_at", "registered_at", "launch_failures_7d", "open_tickets", "profile_completeness"].includes(sp.get("sort") ?? "") ? sp.get("sort") : "last_active_at";
  const rows = all<Record<string, unknown>>(`SELECT player_id, display_name, email, lifecycle_stage, kyc_status, vip_tier, primary_platform, os, last_active_at, registered_at, launch_failures_7d, open_tickets, profile_completeness, self_excluded, rg_restricted FROM customers WHERE ${w.join(" AND ")} ORDER BY ${sort} ${sp.get("dir") === "asc" ? "ASC" : "DESC"} LIMIT ? OFFSET ?`, ...p, limit, offset);
  const total = one<{ n: number }>(`SELECT COUNT(*) n FROM customers WHERE ${w.join(" AND ")}`, ...p)!.n;
  return { total, rows: rows.map((x) => { const m = maskList(user.role_id, x); return m; }) };
});
function maskList(role: string, x: Record<string, unknown>) {
  if (can(role, "pii.read")) return x;
  return { ...x, display_name: String(x.display_name).split(" ").map((s) => s[0] + "***").join(" "), email: String(x.email).replace(/^(.).*(@.*)$/, "$1***$2") };
}
r("GET", "customers/:id", "audience.read", ({ params, user }) => {
  audit(actorOf(user), "data.access.customer360", "customer", params.id, { role: user.role_id, restricted_tx: can(user.role_id, "gaming_transactions.read") });
  return CDP.customer360(params.id, user.role_id);
});
r("POST", "customers/:id/tags", "tags.write", async ({ req, params, user }) => {
  const b = z.object({ tag: z.string(), add: z.boolean() }).parse(await body(req));
  const t = one<{ id: string; tag_type: string }>("SELECT id, tag_type FROM tags WHERE key = ?", b.tag);
  if (!t) throw new HttpError(404, "Tag not found");
  if (t.tag_type === "compliance" && !can(user.role_id, "compliance.write")) throw new HttpError(403, "Compliance tags are managed by Compliance");
  if (b.add) run("INSERT OR IGNORE INTO customer_tags (player_id, tag_id, source, added_at) VALUES (?,?,?,?)", params.id, t.id, `manual:${user.email}`, nowIso());
  else run("DELETE FROM customer_tags WHERE player_id = ? AND tag_id = ?", params.id, t.id);
  audit(actorOf(user), b.add ? "tag.added" : "tag.removed", "customer", params.id, { tag: b.tag });
  SEG.evaluatePlayer(params.id, `tag:${b.tag}`);
  return { ok: true };
});
r("POST", "customers/:id/protect", "compliance.write", async ({ req, params, user }) => {
  const b = z.object({ type: z.enum(["self_exclusion", "rg_restriction"]), reason: z.string().min(3) }).parse(await body(req));
  return CDP.applyProtection(params.id, b.type, b.reason, actorOf(user));
});
r("POST", "customers/:id/identities", "identity.merge", async ({ req, params, user }) => {
  const b = z.object({ type: z.string(), value: z.string(), verified: z.boolean(), source: z.string().default("manual"), confidence: z.number().optional() }).parse(await body(req));
  return CDP.linkIdentity({ player_id: params.id, ...b }, actorOf(user));
});
r("GET", "identities/candidates", "audience.read", () => all("SELECT * FROM identity_merge_candidates ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 100"));
r("GET", "identities/resolve", "audience.read", ({ url }) => CDP.resolveIdentity(url.searchParams.get("type") ?? "", url.searchParams.get("value") ?? "") ?? { player_id: null });
r("GET", "identities/stats", "audience.read", () => all("SELECT identity_type, COUNT(*) n, SUM(verified) verified FROM customer_identities GROUP BY identity_type ORDER BY n DESC"));
r("POST", "identities/candidates/:id", "identity.merge", async ({ req, params, user }) => { const b = z.object({ approve: z.boolean() }).parse(await body(req)); CDP.decideMergeCandidate(params.id, b.approve, actorOf(user)); return { ok: true }; });
r("GET", "audience/overview", "audience.read", () => ({
  lifecycle: all("SELECT lifecycle_stage k, COUNT(*) n FROM customers GROUP BY k"), kyc: all("SELECT kyc_status k, COUNT(*) n FROM customers GROUP BY k"), tiers: all("SELECT vip_tier k, COUNT(*) n FROM customers GROUP BY k"),
  platforms: all("SELECT primary_platform k, COUNT(*) n FROM customers GROUP BY k"), completeness: all("SELECT CAST(profile_completeness * 10 AS INTEGER) * 10 k, COUNT(*) n FROM customers GROUP BY k ORDER BY k"),
  consent: all("SELECT channel, purpose, SUM(granted) granted, COUNT(*) n FROM consent_current GROUP BY channel, purpose"), totals: one("SELECT COUNT(*) customers, SUM(self_excluded OR rg_restricted) protected FROM customers"),
  categories: all("SELECT favorite_category k, COUNT(*) n FROM customers GROUP BY k ORDER BY n DESC"),
}));
r("GET", "gaming/intelligence", "audience.read", ({ url }) => ({ ...M.gamingFunnel(M.parseFilters(url.searchParams)), providers: M.overviewCharts(M.parseFilters(url.searchParams)).providers, sessions: M.overviewCharts(M.parseFilters(url.searchParams)).sessions }));
r("GET", "games", "audience.read", () => all("SELECT g.*, p.name provider FROM games g JOIN gaming_providers p ON p.id = g.provider_id ORDER BY popularity DESC LIMIT 200"));

// events
r("POST", "events", null, async ({ req, user }) => {
  if (!can(user.role_id, "events.ingest")) throw new HttpError(403, "Missing permission: events.ingest");
  rateLimit(`ingest:${user.id}`, 600);
  const b = await body<unknown>(req);
  const list = Array.isArray(b) ? b : Array.isArray((b as { events?: unknown[] }).events) ? (b as { events: unknown[] }).events : [b];
  if (list.length > 5000) throw new HttpError(413, "Max 5000 events per request");
  return CDP.ingestEvents(list, user.id.startsWith("apikey:") ? "api" : "console", actorOf(user));
});
r("GET", "events", "audience.read", ({ url, user }) => {
  const sp = url.searchParams; const w = ["1=1"]; const p: unknown[] = [];
  for (const k of ["player_id", "event_name", "provider_id", "platform", "category"]) { const v = sp.get(k); if (v) { w.push(`${k} = ?`); p.push(v); } }
  const restricted = !can(user.role_id, "gaming_transactions.read");
  return { rows: all(`SELECT seq, event_id, event_name, category, player_id, game_id, provider_id, event_time, platform, operating_system, entry_source, loading_duration, error_code, source, schema_version FROM events WHERE ${w.join(" AND ")} ${restricted ? "AND category != 'gaming_transaction'" : ""} ORDER BY seq DESC LIMIT ?`, ...p, pageArgs(url).limit), rejections: all("SELECT * FROM event_rejections ORDER BY id DESC LIMIT 20"), volume: all("SELECT event_name, COUNT(*) n FROM events WHERE event_time >= ? GROUP BY event_name ORDER BY n DESC", new Date(Date.now() - 86400_000).toISOString()) };
});
r("GET", "event-definitions", "audience.read", () => all<Record<string, unknown>>("SELECT * FROM event_definitions ORDER BY category, name").map((d) => ({ ...d, required_attributes: J.parse(d.required_attributes, []) })));
r("POST", "event-definitions", "settings.write", async ({ req, user }) => {
  const b = z.object({ name: z.string().regex(/^[a-z_]{3,60}$/), category: z.string(), description: z.string().optional(), required_attributes: z.array(z.string()).default(["player_id"]), enabled: z.boolean().default(true) }).parse(await body(req));
  const ex = one<{ version: number }>("SELECT version FROM event_definitions WHERE name = ?", b.name);
  const v = (ex?.version ?? 0) + 1;
  run("INSERT OR REPLACE INTO event_definitions (name, category, description, version, required_attributes, restricted, enabled, updated_at) VALUES (?,?,?,?,?,0,?,?)", b.name, b.category, b.description ?? null, v, J.str(b.required_attributes), b.enabled ? 1 : 0, nowIso());
  run("INSERT INTO event_definition_history (name, version, snapshot, changed_by, changed_at) VALUES (?,?,?,?,?)", b.name, v, J.str(b), user.email, nowIso());
  audit(actorOf(user), "event_definition.saved", "event_definition", b.name, { version: v });
  return { ok: true, version: v };
});

// tags
r("GET", "tags", "audience.read", () => all("SELECT t.*, (SELECT COUNT(*) FROM customer_tags ct WHERE ct.tag_id = t.id) members FROM tags t ORDER BY t.tag_type, t.name"));
r("POST", "tags", "tags.write", async ({ req, user }) => {
  const b = z.object({ key: z.string().regex(/^[a-z0-9_]{2,40}$/), name: z.string().min(2), tag_type: z.enum(["manual", "system", "event", "computed", "temporary", "ai_suggested", "compliance"]), description: z.string().optional(), expires_after_days: z.number().int().optional(), refresh_policy: z.string().optional(), usage_restriction: z.string().optional() }).parse(await body(req));
  if (b.tag_type === "compliance" && !can(user.role_id, "compliance.write")) throw new HttpError(403, "Compliance tags require compliance.write");
  const tid = `tag_${b.key}`;
  run("INSERT INTO tags (id, org_id, key, name, tag_type, description, owner, refresh_policy, usage_restriction, expires_after_days, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", tid, ORG_ID, b.key, b.name, b.tag_type, b.description ?? null, user.email, b.refresh_policy ?? "manual", b.usage_restriction ?? null, b.expires_after_days ?? null, nowIso());
  audit(actorOf(user), "tag.created", "tag", tid, b);
  return { id: tid };
});

// segments
r("GET", "segments", "audience.read", () => all<Record<string, unknown>>("SELECT * FROM segments ORDER BY updated_at DESC").map((s) => ({ ...s, rules: J.parse(s.rules, null), description_rules: SEG.describeRule(J.parse(s.rules, { type: "group", op: "and", children: [] })) })));
r("GET", "segments/fields", "audience.read", () => ({ fields: SEG.FIELDS, events: all("SELECT name, category FROM event_definitions WHERE enabled = 1"), tags: all("SELECT key, name, tag_type FROM tags"), segments: all("SELECT id, name FROM segments") }));
r("POST", "segments/estimate", "audience.read", async ({ req }) => { const b = z.object({ rules: SEG.RuleSchema, purpose: z.string().optional() }).parse(await body(req)); return { ...SEG.estimate(b.rules, b.purpose), description: SEG.describeRule(b.rules) }; });
r("POST", "segments/ai", "audience.read", async ({ req }) => {
  const b = z.object({ description: z.string().min(5).max(500), purpose: z.string().default("service") }).parse(await body(req));
  const p = parseSegment(b.description);
  if (p.refused) return { refused: p.refused };
  return { rules: p.rule, explanation: p.explanation, ...SEG.estimate(p.rule, b.purpose), description: SEG.describeRule(p.rule), generated_by: activeProvider() === "mock" ? "deterministic parser (mock AI)" : activeProvider() };
});
r("POST", "segments", "segments.write", async ({ req, user }) => {
  const b = z.object({ name: z.string().min(2).max(100), description: z.string().optional(), type: z.enum(["static", "dynamic", "realtime"]), purpose: z.enum(["service", "security", "operational", "protective", "membership", "marketing"]), rules: SEG.RuleSchema, ai_generated: z.boolean().optional() }).parse(await body(req));
  return SEG.createSegment({ ...b, aiGenerated: b.ai_generated }, actorOf(user));
});
r("GET", "segments/overlap", "audience.read", ({ url }) => SEG.overlap((url.searchParams.get("ids") ?? "").split(",").filter(Boolean).slice(0, 6)));
r("GET", "segments/:id", "audience.read", ({ params, user }) => {
  const s = one<Record<string, unknown>>("SELECT * FROM segments WHERE id = ?", params.id);
  if (!s) throw new HttpError(404, "Segment not found");
  const members = all<Record<string, unknown>>("SELECT c.player_id, c.display_name, c.lifecycle_stage, c.kyc_status, c.vip_tier, c.primary_platform, m.joined_at FROM segment_memberships m JOIN customers c ON c.player_id = m.player_id WHERE m.segment_id = ? ORDER BY m.joined_at DESC LIMIT 50", params.id).map((x) => maskList(user.role_id, x));
  return { segment: { ...s, rules: J.parse(s.rules, null), description_rules: SEG.describeRule(J.parse(s.rules, { type: "group", op: "and", children: [] })) }, members, versions: all("SELECT * FROM segment_versions WHERE segment_id = ? ORDER BY version DESC", params.id), history: all("SELECT * FROM segment_membership_history WHERE segment_id = ? ORDER BY id DESC LIMIT 50", params.id), daily: all("SELECT substr(at,1,10) d, SUM(action='enter') entered, SUM(action='exit') exited FROM segment_membership_history WHERE segment_id = ? GROUP BY d ORDER BY d", params.id) };
});
r("PUT", "segments/:id", "segments.write", async ({ req, params, user }) => { const b = z.object({ rules: SEG.RuleSchema }).parse(await body(req)); return SEG.updateSegmentRules(params.id, b.rules, actorOf(user)); });
r("POST", "segments/:id/evaluate", "segments.write", ({ params, user }) => { const x = SEG.evaluateSegment(params.id, actorOf(user), "manual_refresh"); return { entered: x.entered.length, exited: x.exited.length, size: x.size }; });
r("POST", "segments/:id/status", "segments.write", async ({ req, params, user }) => { const b = z.object({ status: z.enum(["active", "paused", "archived"]) }).parse(await body(req)); run("UPDATE segments SET status = ?, updated_at = ? WHERE id = ?", b.status, nowIso(), params.id); audit(actorOf(user), "segment.status", "segment", params.id, b); return { ok: true }; });

// ───────── offers ─────────
r("GET", "offers", "offers.read", () => all<Record<string, unknown>>("SELECT o.*, (SELECT COUNT(*) FROM offer_transactions t WHERE t.offer_id = o.id) issued FROM offers o ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, name").map((o) => ({ ...o, eligibility: J.parse(o.eligibility, {}) })));
r("POST", "offers", "offers.write", async ({ req, user }) => {
  const b = z.object({ name: z.string().min(3), category: z.enum(OFF.OFFER_CATEGORIES), description: z.string().optional(), base_amount: z.number().positive().max(100000), eligibility: z.record(z.unknown()).default({}), validity_days: z.number().int().min(1).max(365).default(14), per_user_limit: z.number().int().min(1).max(12).default(1), requires_approval: z.boolean().default(true) }).parse(await body(req));
  const oid = id("off");
  run("INSERT INTO offers (id, org_id, name, category, description, base_amount, unit, eligibility, validity_days, per_user_limit, status, version, requires_approval, allow_personalization, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'draft',1,?,?,?,?)",
    oid, ORG_ID, b.name, b.category, b.description ?? null, b.base_amount, "PHP", J.str(b.eligibility), b.validity_days, b.per_user_limit, b.requires_approval ? 1 : 0, b.category === "membership_benefit" ? 1 : 0, nowIso(), nowIso());
  run("INSERT INTO offer_versions (offer_id, version, snapshot, created_by, created_at) VALUES (?,?,?,?,?)", oid, 1, J.str(b), user.email, nowIso());
  audit(actorOf(user), "offer.created", "offer", oid, b);
  return { id: oid };
});
r("GET", "offers/budgets", "offers.read", () => all("SELECT * FROM offer_budgets"));
r("POST", "offers/budgets", "budgets.write", async ({ req, user }) => {
  const b = z.object({ name: z.string(), scope: z.enum(["total", "daily", "campaign", "offer"]), offer_id: z.string().optional(), total: z.number().positive(), daily_limit: z.number().optional(), days: z.number().int().min(1).max(366).default(30) }).parse(await body(req));
  const bid = id("bud");
  run("INSERT INTO offer_budgets (id, org_id, name, scope, offer_id, total, daily_limit, period_start, period_end, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)", bid, ORG_ID, b.name, b.scope, b.offer_id ?? null, b.total, b.daily_limit ?? null, nowIso(), new Date(Date.now() + b.days * 86400_000).toISOString(), nowIso());
  audit(actorOf(user), "budget.created", "budget", bid, b);
  return { id: bid };
});
r("GET", "offers/reconcile", "offers.read", () => OFF.reconcile());
r("GET", "offers/transactions", "offers.read", ({ url }) => all(`SELECT t.*, o.name offer FROM offer_transactions t JOIN offers o ON o.id = t.offer_id ${url.searchParams.get("offer") ? "WHERE t.offer_id = ?" : ""} ORDER BY t.updated_at DESC LIMIT 200`, ...(url.searchParams.get("offer") ? [url.searchParams.get("offer")] : [])));
r("POST", "offers/transactions/:id", "offers.issue", async ({ req, params, user }) => { const b = z.object({ to: z.enum(["claimed", "redeemed", "expired", "cancelled", "reversed"]) }).parse(await body(req)); return OFF.transition(params.id, b.to, actorOf(user)); });
r("GET", "offers/analytics", "offers.read", () => M.offerAnalytics());
r("GET", "offers/:id", "offers.read", ({ params }) => {
  const o = one<Record<string, unknown>>("SELECT * FROM offers WHERE id = ?", params.id);
  if (!o) throw new HttpError(404, "Offer not found");
  return { offer: { ...o, eligibility: J.parse(o.eligibility, {}) }, versions: all("SELECT * FROM offer_versions WHERE offer_id = ? ORDER BY version DESC", params.id), budget: OFF.budgetFor(params.id), batches: all("SELECT batch_id, MIN(created_at) at, COUNT(*) n, SUM(outcome != 'none') eligible, SUM(approved_amount) amount, MAX(approval_status) status, MAX(simulated) simulated, MAX(strategy_version) strategy_version FROM offer_decisions WHERE offer_id = ? GROUP BY batch_id ORDER BY at DESC LIMIT 20", params.id) };
});
r("PUT", "offers/:id", "offers.write", async ({ req, params, user }) => {
  const b = z.object({ status: z.enum(["draft", "active", "paused", "archived"]).optional(), base_amount: z.number().positive().optional(), eligibility: z.record(z.unknown()).optional(), per_user_limit: z.number().int().optional(), validity_days: z.number().int().optional() }).parse(await body(req));
  if (b.status === "active" && !can(user.role_id, "approvals.decide")) throw new HttpError(403, "Activating an offer requires an approver role");
  const o = one<{ version: number }>("SELECT version FROM offers WHERE id = ?", params.id); if (!o) throw new HttpError(404, "Offer not found");
  const sets = Object.entries(b).filter(([, v]) => v !== undefined);
  run(`UPDATE offers SET ${sets.map(([k]) => `${k} = ?`).join(", ")}${sets.length ? "," : ""} version = version + 1, updated_at = ? WHERE id = ?`, ...sets.map(([k, v]) => (k === "eligibility" ? J.str(v) : v)), nowIso(), params.id);
  run("INSERT INTO offer_versions (offer_id, version, snapshot, created_by, created_at) VALUES (?,?,?,?,?)", params.id, o.version + 1, J.str(b), user.email, nowIso());
  audit(actorOf(user), "offer.updated", "offer", params.id, b);
  return { ok: true };
});
r("POST", "offers/:id/simulate", "offers.read", async ({ req, params }) => {
  const b = z.object({ segment_id: z.string().optional(), player_ids: z.array(z.string()).optional(), config: z.record(z.unknown()).optional(), budget_ratio_override: z.number().optional() }).parse(await body(req));
  const ids = b.player_ids?.length ? b.player_ids : all<{ player_id: string }>("SELECT player_id FROM segment_memberships WHERE segment_id = ? LIMIT 3000", b.segment_id ?? "seg_02").map((x) => x.player_id);
  const { decisions, strategy } = OFF.decideForPlayers(params.id, ids, { config: b.config });
  return { strategy, summary: OFF.summarizeDecisions(decisions), decisions: decisions.slice(0, 200) };
});
r("POST", "offers/:id/batch", "offers.write", async ({ req, params, user }) => {
  const b = z.object({ segment_id: z.string(), simulate: z.boolean().default(true) }).parse(await body(req));
  if (!b.simulate && !can(user.role_id, "offers.issue") && !can(user.role_id, "offers.write")) throw new HttpError(403, "Missing offers.issue");
  const ids = all<{ player_id: string }>("SELECT player_id FROM segment_memberships WHERE segment_id = ? LIMIT 5000", b.segment_id).map((x) => x.player_id);
  const res = OFF.runBatch(params.id, ids, { simulate: b.simulate, actor: actorOf(user) });
  return { batch_id: res.batchId, summary: res.summary, strategy: res.strategy, approval_id: res.approvalId, issued: res.issued, sample: res.decisions.slice(0, 50) };
});
r("GET", "offers/batches/:id", "offers.read", ({ params }) => all("SELECT d.*, c.vip_tier FROM offer_decisions d JOIN customers c ON c.player_id = d.player_id WHERE d.batch_id = ? LIMIT 500", params.id));

// ───────── campaigns ─────────
r("GET", "campaigns", "campaigns.read", () => all<Record<string, unknown>>("SELECT c.*, s.name segment_name, s.member_count FROM campaigns c LEFT JOIN segments s ON s.id = c.segment_id ORDER BY c.updated_at DESC").map((c) => ({ ...c, channels: J.parse(c.channels, []), stats: J.parse(c.stats, {}), ab_test: J.parse(c.ab_test, null) })));
r("GET", "campaigns/meta", "campaigns.read", () => ({ objectives: CMP.OBJECTIVES, segments: all("SELECT id, name, purpose, member_count FROM segments WHERE status = 'active' ORDER BY name"), templates: all("SELECT id, name, channel, purpose, status, body FROM message_templates ORDER BY name"), channels: all("SELECT key, name, cost_per_message, health FROM channels WHERE enabled = 1") }));
r("POST", "campaigns", "campaigns.write", async ({ req, user }) => {
  const b = z.object({ name: z.string().min(3), objective: z.enum(Object.keys(CMP.OBJECTIVES) as [keyof typeof CMP.OBJECTIVES]), segment_id: z.string(), channels: z.array(z.string()).min(1), template_id: z.string(), schedule_at: z.string().nullable().optional(), timezone: z.string().optional(), budget: z.number().min(0).optional(), ab_test: z.object({ variant_b_template_id: z.string(), split: z.number().min(0.05).max(0.95) }).nullable().optional() }).parse(await body(req));
  return CMP.createCampaign(b, actorOf(user));
});
r("GET", "campaigns/:id", "campaigns.read", ({ params }) => { const rep = CMP.campaignReport(params.id); return { ...rep, campaign: { ...rep.campaign, channels: J.parse(rep.campaign.channels, []), stats: J.parse(rep.campaign.stats, {}), ab_test: J.parse(rep.campaign.ab_test, null) } }; });
r("PUT", "campaigns/:id", "campaigns.write", async ({ req, params, user }) => CMP.updateCampaign(params.id, await body(req), actorOf(user)));
r("POST", "campaigns/:id/action", "campaigns.read", async ({ req, params, user }) => {
  const b = z.object({ action: z.enum(["validate", "submit", "execute", "simulate", "pause", "cancel", "duplicate"]) }).parse(await body(req));
  const need: Record<string, Permission> = { submit: "campaigns.write", execute: "campaigns.execute", pause: "campaigns.write", cancel: "campaigns.write", duplicate: "campaigns.write", validate: "campaigns.read", simulate: "campaigns.read" };
  if (!can(user.role_id, need[b.action])) throw new HttpError(403, `Missing permission: ${need[b.action]}`);
  const a = actorOf(user);
  switch (b.action) {
    case "validate": return CMP.validateCampaign(params.id);
    case "submit": return CMP.submitCampaign(params.id, a);
    case "execute": return CMP.executeCampaign(params.id, a);
    case "simulate": return CMP.executeCampaign(params.id, a, { simulate: true });
    case "pause": CMP.setCampaignStatus(params.id, "paused", a); return { ok: true };
    case "cancel": CMP.setCampaignStatus(params.id, "cancelled", a); return { ok: true };
    case "duplicate": return CMP.duplicateCampaign(params.id, a);
  }
});

// ───────── journeys ─────────
r("GET", "journeys", "journeys.read", () => all("SELECT j.*, (SELECT COUNT(*) FROM journey_executions e WHERE e.journey_id = j.id AND e.status IN ('active','waiting')) active_execs, (SELECT COUNT(*) FROM journey_executions e WHERE e.journey_id = j.id) total_execs FROM journeys j ORDER BY j.updated_at DESC"));
r("GET", "journeys/meta", "journeys.read", () => ({ catalog: JRN.NODE_CATALOG, segments: all("SELECT id, name, purpose FROM segments ORDER BY name"), templates: all("SELECT id, name, channel, purpose, status FROM message_templates WHERE status = 'approved'"), offers: all("SELECT id, name FROM offers WHERE status = 'active'"), tags: all("SELECT key, name FROM tags"), events: all("SELECT name FROM event_definitions"), channels: all("SELECT key, name FROM channels"), fields: SEG.FIELDS }));
r("POST", "journeys", "journeys.write", async ({ req, user }) => {
  const b = z.object({ name: z.string().min(3), purpose: z.enum(["service", "operational", "protective", "membership", "marketing"]), description: z.string().optional(), strategy_category: z.string().nullable().optional() }).parse(await body(req));
  const jid = id("jrn");
  const def = { nodes: [{ id: "t1", type: "trigger", kind: "manual", data: {}, position: { x: 0, y: 0 } }, { id: "e1", type: "flow", kind: "end", data: {}, position: { x: 0, y: 160 } }], edges: [{ id: "e0", source: "t1", target: "e1" }] };
  run("INSERT INTO journeys (id, org_id, name, description, purpose, status, draft_definition, strategy_category, created_by, created_at, updated_at) VALUES (?,?,?,?,?,'draft',?,?,?,?,?)", jid, ORG_ID, b.name, b.description ?? null, b.purpose, J.str(def), b.strategy_category ?? null, user.email, nowIso(), nowIso());
  audit(actorOf(user), "journey.created", "journey", jid, b);
  return { id: jid };
});
r("GET", "journeys/:id", "journeys.read", ({ params }) => {
  const j = JRN.getJourney(params.id);
  return { journey: { ...j, draft_definition: J.parse(j.draft_definition, null) }, versions: all("SELECT journey_id, version, strategy_version, status, published_by, published_at, approval_id FROM journey_versions WHERE journey_id = ? ORDER BY version DESC", params.id), stats: JRN.journeyStats(params.id), executions: all("SELECT id, player_id, version, status, current_node, wake_at, strategy_version, exit_reason, started_at, updated_at FROM journey_executions WHERE journey_id = ? ORDER BY updated_at DESC LIMIT 50", params.id) };
});
r("PUT", "journeys/:id", "journeys.write", async ({ req, params, user }) => { const b = await body<{ definition: JRN.JourneyDef }>(req); JRN.saveDraft(params.id, b.definition, actorOf(user)); return { ok: true, issues: JRN.validate(b.definition, JRN.getJourney(params.id).purpose) }; });
r("POST", "journeys/:id/action", "journeys.read", async ({ req, params, user }) => {
  const b = z.object({ action: z.enum(["validate", "simulate", "publish", "pause", "resume", "stop", "tick", "fast_forward", "enroll_segment"]), hours: z.number().min(1).max(168).optional() }).parse(await body(req));
  const j = JRN.getJourney(params.id); const def = J.parse<JRN.JourneyDef>(j.draft_definition, { nodes: [], edges: [] });
  const need: Record<string, Permission> = { validate: "journeys.read", simulate: "journeys.read", publish: "journeys.publish", pause: "journeys.publish", resume: "journeys.publish", stop: "journeys.publish", tick: "journeys.write", fast_forward: "journeys.write", enroll_segment: "journeys.publish" };
  if (!can(user.role_id, need[b.action])) throw new HttpError(403, `Missing permission: ${need[b.action]}`);
  const a = actorOf(user);
  switch (b.action) {
    case "validate": return { issues: JRN.validate(def, j.purpose) };
    case "simulate": return JRN.simulate(def, j.purpose, 300);
    case "publish": return JRN.publishJourney(params.id, a);
    case "pause": JRN.setJourneyStatus(params.id, "paused", a); return { ok: true };
    case "resume": JRN.setJourneyStatus(params.id, "active", a); return { ok: true };
    case "stop": JRN.setJourneyStatus(params.id, "stopped", a); return { ok: true };
    case "tick": return { processed: JRN.processDue() };
    case "fast_forward": {
      // MOCK MODE ONLY: advances the platform clock so waits elapse; recorded in the audit log.
      const h = b.hours ?? 24;
      run("UPDATE system_clock SET offset_minutes = offset_minutes + ? WHERE id = 1", h * 60);
      audit(a, "system.clock_fast_forward", "system", "clock", { hours: h, mock_only: true });
      return { processed: JRN.processDue(), advanced_hours: h };
    }
    case "enroll_segment": {
      const pub = one<{ definition: string }>("SELECT definition FROM journey_versions WHERE journey_id = ? AND version = ?", params.id, j.published_version ?? 0);
      const trig = J.parse<JRN.JourneyDef>(pub?.definition, { nodes: [], edges: [] }).nodes.find((n) => n.type === "trigger");
      if (!trig?.data.segment_id) throw new HttpError(409, "Published version has no segment trigger");
      return JRN.enroll(params.id, all<{ player_id: string }>("SELECT player_id FROM segment_memberships WHERE segment_id = ?", trig.data.segment_id).map((x) => x.player_id), "manual_enroll");
    }
  }
});
r("POST", "journeys/executions/:id/stop", "journeys.publish", ({ params, user }) => { JRN.stopExecution(params.id, actorOf(user)); return { ok: true }; });

// ───────── omni channel ─────────
r("GET", "channels", "channels.read", () => {
  const stats = new Map(MSG.channelStats(24 * 7).map((s) => [s.channel, s]));
  const day = new Map(MSG.channelStats(24).map((s) => [s.channel, s]));
  return all<Record<string, unknown>>("SELECT * FROM channels").map((c) => ({ ...c, config: J.parse(c.config, {}), retry_policy: J.parse(c.retry_policy, {}), fallback_channels: J.parse(c.fallback_channels, []), stats_7d: stats.get(String(c.key)) ?? null, stats_24h: day.get(String(c.key)) ?? null, errors: all("SELECT error_code, COUNT(*) n FROM messages WHERE channel = ? AND error_code IS NOT NULL AND created_at >= ? GROUP BY error_code ORDER BY n DESC LIMIT 5", c.key, new Date(Date.now() - 7 * 86400_000).toISOString()) }));
});
r("PUT", "channels/:key", "channels.write", async ({ req, params, user }) => {
  const b = z.object({ enabled: z.boolean().optional(), cost_per_message: z.number().min(0).optional(), fallback_channels: z.array(z.string()).optional(), retry_policy: z.record(z.unknown()).optional(), mode: z.enum(["mock", "live"]).optional() }).parse(await body(req));
  if (b.mode === "live") throw new HttpError(409, "Live mode requires a verified provider integration (see docs/INTEGRATIONS.md). Credentials are configured server-side only.");
  const sets = Object.entries(b).filter(([, v]) => v !== undefined);
  if (sets.length) run(`UPDATE channels SET ${sets.map(([k]) => `${k} = ?`).join(", ")} WHERE key = ?`, ...sets.map(([k, v]) => (k === "enabled" ? (v ? 1 : 0) : typeof v === "object" ? J.str(v) : v)), params.key);
  audit(actorOf(user), "channel.updated", "channel", params.key, b);
  return { ok: true };
});
r("POST", "channels/:key/test", "channels.write", ({ params, user }) => {
  const c = one<MSG.Channel>("SELECT * FROM channels WHERE key = ?", params.key); if (!c) throw new HttpError(404, "Channel not found");
  audit(actorOf(user), "channel.health_check", "channel", params.key, { mode: c.mode });
  return { mode: c.mode, connection_status: c.connection_status, result: c.mode === "mock" ? "Mock adapter responded OK. No external provider was contacted — this channel is NOT connected to a real provider." : "Live verification not available in this build." };
});
r("GET", "templates", "channels.read", () => all<Record<string, unknown>>("SELECT * FROM message_templates ORDER BY updated_at DESC").map((t) => ({ ...t, variables: J.parse(t.variables, []), compliance_result: J.parse(t.compliance_result, null) })));
r("POST", "templates", "templates.write", async ({ req, user }) => {
  const b = z.object({ name: z.string().min(3), channel: z.string(), language: z.string().default("en"), purpose: z.enum(["service", "security", "operational", "protective", "membership", "marketing"]), subject: z.string().optional(), body: z.string().min(5).max(2000), ai_drafted: z.boolean().optional() }).parse(await body(req));
  const tid = id("tpl");
  run("INSERT INTO message_templates (id, org_id, name, channel, language, purpose, subject, body, variables, status, compliance_result, ai_drafted, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,'draft',?,?,?,?)", tid, ORG_ID, b.name, b.channel, b.language, b.purpose, b.subject ?? null, b.body, J.str((b.body.match(/\{\{\s*(\w+)\s*\}\}/g) ?? []).map((x) => x.replace(/[{}\s]/g, ""))), J.str({ passed: !validateContent(b.body, b.purpose).length, issues: validateContent(b.body, b.purpose) }), b.ai_drafted ? 1 : 0, nowIso(), nowIso());
  run("INSERT INTO template_versions (template_id, version, snapshot, created_at) VALUES (?,1,?,?)", tid, J.str(b), nowIso());
  audit(actorOf(user), "template.created", "template", tid, { name: b.name });
  return { id: tid };
});
r("PUT", "templates/:id", "templates.write", async ({ req, params, user }) => {
  const b = z.object({ body: z.string().min(5).max(2000), subject: z.string().optional() }).parse(await body(req));
  const t = one<{ version: number; purpose: string }>("SELECT version, purpose FROM message_templates WHERE id = ?", params.id); if (!t) throw new HttpError(404, "Template not found");
  run("UPDATE message_templates SET body = ?, subject = COALESCE(?, subject), version = version + 1, status = 'draft', compliance_result = ?, updated_at = ? WHERE id = ?", b.body, b.subject ?? null, J.str({ passed: !validateContent(b.body, t.purpose).length, issues: validateContent(b.body, t.purpose) }), nowIso(), params.id);
  run("INSERT INTO template_versions (template_id, version, snapshot, created_at) VALUES (?,?,?,?)", params.id, t.version + 1, J.str(b), nowIso());
  audit(actorOf(user), "template.updated", "template", params.id, {});
  return { ok: true };
});
r("POST", "templates/:id/submit", "templates.write", ({ params, user }) => MSG.submitTemplate(params.id, actorOf(user)));
r("POST", "templates/draft", "templates.write", async ({ req }) => {
  const b = z.object({ purpose: z.string(), channel: z.string(), topic: z.string().min(3) }).parse(await body(req));
  const promo = ["membership", "marketing"].includes(b.purpose);
  const short = ["sms", "app_push", "web_push"].includes(b.channel);
  const text = `Hi {{first_name}}, ${b.topic.replace(/\.$/, "")}.${short ? "" : " If you need help, our support team is available 24/7."}${promo ? " 21+ only. Play responsibly. Opt out anytime in Settings." : ""}`;
  return { body: text, issues: validateContent(text, b.purpose), generated_by: activeProvider() === "mock" ? "template assistant (mock AI)" : activeProvider(), note: "AI-assisted draft — requires compliance validation and approval before use." };
});
r("GET", "messages", "channels.read", ({ url }) => {
  const sp = url.searchParams; const w = ["1=1"]; const p: unknown[] = [];
  for (const k of ["channel", "status", "campaign_id", "run_id", "player_id", "purpose"]) { const v = sp.get(k); if (v) { w.push(`${k} = ?`); p.push(v); } }
  return { rows: all(`SELECT id, player_id, channel, purpose, status, error_code, cost, campaign_id, journey_id, run_id, variant, created_at FROM messages WHERE ${w.join(" AND ")} ORDER BY created_at DESC LIMIT ?`, ...p, pageArgs(url).limit), funnel: all(`SELECT status, COUNT(*) n FROM delivery_events WHERE message_id IN (SELECT id FROM messages WHERE ${w.join(" AND ")} ORDER BY created_at DESC LIMIT 20000) GROUP BY status`, ...p) };
});
r("POST", "webhooks/delivery", null, async ({ req }) => {
  const raw = await req.text();
  if (!MSG.verifyWebhookSignature(raw, req.headers.get("x-aec-signature"))) throw new HttpError(401, "Invalid webhook signature");
  const b = z.object({ message_id: z.string(), status: z.enum(["queued", "sent", "delivered", "read", "clicked", "failed", "rejected", "unsubscribed", "cancelled"]), error_code: z.string().optional(), provider_ref: z.string().optional() }).parse(J.parse(raw, {}));
  return MSG.ingestDeliveryEvent(b);
}, true);

// ───────── analytics ─────────
r("GET", "analytics/:module", "analytics.read", ({ params, url }) => {
  const f = M.parseFilters(url.searchParams);
  switch (params.module) {
    case "customers": return { ...M.overviewCharts(f), metrics: M.overview(f).customer, cohorts: M.cohorts() };
    case "gaming": return M.gamingFunnel(f);
    case "campaigns": return { campaigns: all("SELECT c.id, c.name, c.purpose, c.status, COUNT(m.id) sent, SUM(m.status IN ('delivered','read','clicked')) delivered, SUM(m.status IN ('read','clicked')) read, SUM(m.status = 'clicked') clicked, ROUND(SUM(m.cost),2) cost FROM campaigns c LEFT JOIN messages m ON m.campaign_id = c.id GROUP BY c.id ORDER BY sent DESC"), attribution: M.attribution(f) };
    case "journeys": return all("SELECT j.name, j.status, COUNT(e.id) execs, SUM(e.status = 'completed') completed, SUM(e.status = 'exited') exited, SUM(e.status IN ('active','waiting')) active, SUM(e.status = 'error') errors FROM journeys j LEFT JOIN journey_executions e ON e.journey_id = j.id GROUP BY j.id");
    case "channels": return { stats: MSG.channelStats((new Date(f.to).getTime() - new Date(f.from).getTime()) / 3600_000), daily: all("SELECT substr(created_at,1,10) d, channel, COUNT(*) n, SUM(status IN ('delivered','read','clicked')) delivered FROM messages WHERE created_at >= ? GROUP BY d, channel ORDER BY d", f.from) };
    case "segments": return M.segmentAnalytics();
    case "offers": return M.offerAnalytics();
    case "service": return M.csAnalytics(f);
    case "cohorts": return M.cohorts();
    case "attribution": return M.attribution(f);
    case "costs": return M.costAnalysis(f);
    case "ai": return M.aiPerformance(f);
    case "strategies": return M.strategyPerformance();
    case "compliance": return M.complianceAnalytics(f);
  }
  throw new HttpError(404, "Unknown analytics module");
});

// ───────── strategies ─────────
r("GET", "strategies", "strategies.read", () => ({ strategies: STR.listStrategies(), settings: STR.optimizerSettings(), next_evaluation: new Date(Date.now() + STR.optimizerSettings().evaluation_frequency_hours * 3600_000).toISOString(), recent: all("SELECT e.*, s.name FROM strategy_evaluations e JOIN strategies s ON s.id = e.strategy_id ORDER BY e.at DESC LIMIT 20") }));
r("GET", "strategies/:id", "strategies.read", ({ params }) => {
  const s = one<Record<string, unknown>>("SELECT * FROM strategies WHERE id = ?", params.id); if (!s) throw new HttpError(404, "Strategy not found");
  return { strategy: s, versions: all<Record<string, unknown>>("SELECT * FROM strategy_versions WHERE strategy_id = ? ORDER BY version DESC", params.id).map((v) => ({ ...v, config: J.parse(v.config, {}), baseline_metrics: J.parse(v.baseline_metrics, null), candidate_metrics: J.parse(v.candidate_metrics, null) })),
    experiments: all<Record<string, unknown>>("SELECT * FROM experiments WHERE strategy_id = ? ORDER BY started_at DESC", params.id).map((e) => ({ ...e, results: all("SELECT * FROM experiment_results WHERE experiment_id = ?", e.id) })),
    evaluations: all<Record<string, unknown>>("SELECT * FROM strategy_evaluations WHERE strategy_id = ? ORDER BY at DESC LIMIT 40", params.id).map((e) => ({ ...e, metrics: J.parse(e.metrics, {}) })),
    runs: all("SELECT id, status, strategy_version, started_at FROM ai_workflow_runs WHERE strategy_id = ? ORDER BY started_at DESC LIMIT 20", params.id),
    audit: all("SELECT * FROM audit_logs WHERE entity_type = 'strategy' AND entity_id = ? ORDER BY seq DESC LIMIT 30", params.id) };
});
r("POST", "strategies/:id/action", "strategies.write", async ({ req, params, user }) => {
  const b = z.object({ action: z.enum(["activate", "rollback", "pause", "archive", "submit", "candidate"]), version: z.number().int().optional(), config: z.record(z.unknown()).optional(), summary: z.string().optional() }).parse(await body(req));
  const a = actorOf(user);
  if (["activate", "rollback"].includes(b.action) && !can(user.role_id, "strategies.activate")) throw new HttpError(403, "Missing permission: strategies.activate");
  switch (b.action) {
    case "activate": STR.activate(params.id, b.version!, a); return { ok: true };
    case "rollback": return STR.rollback(params.id, a, "manual rollback");
    case "pause": STR.setStatus(params.id, b.version!, "paused", a); return { ok: true };
    case "archive": STR.setStatus(params.id, b.version!, "archived", a); return { ok: true };
    case "submit": return STR.submitForApproval(params.id, b.version!, user.email);
    case "candidate": { const s = one<{ category: string }>("SELECT category FROM strategies WHERE id = ?", params.id)!; return STR.createCandidate({ category: s.category, config: b.config ?? {}, summary: b.summary ?? "Manual candidate", createdBy: user.email, risk: "medium" }); }
  }
});
r("PUT", "optimizer/settings", "strategies.activate", async ({ req, user }) => {
  const b = z.object({ auto_optimization: z.boolean(), evaluation_frequency_hours: z.number().min(1).max(720), min_sample: z.number().int().min(10), min_improvement: z.number().min(0).max(1), confidence: z.number().min(0.5).max(0.999), max_deterioration: z.number().min(0).max(1), risk_threshold: z.enum(["low", "medium", "high"]), approval_mode: z.enum(["manual", "auto"]), auto_rollback: z.boolean(), experiment_allocation: z.number().min(0.01).max(0.5) }).parse(await body(req));
  run("INSERT OR REPLACE INTO settings (key, value, updated_by, updated_at) VALUES ('optimizer', ?, ?, ?)", J.str(b), user.email, nowIso());
  audit(actorOf(user), "optimizer.settings_updated", "settings", "optimizer", b);
  return { ok: true };
});

// ───────── compliance / approvals / audit ─────────
r("GET", "compliance/policies", "compliance.read", () => all<Record<string, unknown>>("SELECT * FROM compliance_policies ORDER BY mandatory DESC, name").map((p) => ({ ...p, config: J.parse(p.config, {}), effective: policies()[String(p.key)] })));
r("PUT", "compliance/policies/:key", "compliance.write", async ({ req, params, user }) => {
  const b = z.object({ enabled: z.boolean().optional(), config: z.record(z.unknown()).optional() }).parse(await body(req));
  const p = one<{ mandatory: number }>("SELECT mandatory FROM compliance_policies WHERE key = ?", params.key); if (!p) throw new HttpError(404, "Policy not found");
  if (p.mandatory && b.enabled === false) throw new HttpError(409, "Mandatory policies cannot be disabled");
  if (params.key === "age_eligibility" && b.config && Number(b.config.min_age) < 18) throw new HttpError(422, "Minimum age cannot be below 18");
  run("UPDATE compliance_policies SET enabled = COALESCE(?, enabled), config = COALESCE(?, config), updated_by = ?, updated_at = ? WHERE key = ?", b.enabled == null ? null : b.enabled ? 1 : 0, b.config ? J.str(b.config) : null, user.email, nowIso(), params.key);
  audit(actorOf(user), "compliance.policy_updated", "policy", params.key, b);
  return { ok: true };
});
r("POST", "compliance/validate", "compliance.read", async ({ req }) => {
  const b = z.object({ player_ids: z.array(z.string()).max(5000).optional(), segment_id: z.string().optional(), purpose: z.string(), channel: z.string().optional(), action: z.enum(["message", "offer", "targeting"]).default("message"), body: z.string().optional() }).parse(await body(req));
  const ids = b.player_ids ?? all<{ player_id: string }>("SELECT player_id FROM segment_memberships WHERE segment_id = ?", b.segment_id ?? "").map((x) => x.player_id);
  const res = evaluate({ playerIds: ids, purpose: b.purpose, channel: b.channel, action: b.action, context: "manual_validation" });
  return { total: res.length, allowed: res.filter((x) => x.allowed).length, by_policy: summarize(res), blocked_sample: res.filter((x) => !x.allowed).slice(0, 20), content: b.body ? validateContent(b.body, b.purpose) : [] };
});
r("GET", "compliance/checks", "compliance.read", () => all("SELECT * FROM compliance_checks ORDER BY id DESC LIMIT 100"));
r("GET", "compliance/exclusions", "compliance.read", ({ user }) => all<Record<string, unknown>>("SELECT e.*, c.display_name FROM exclusion_records e JOIN customers c ON c.player_id = e.player_id WHERE e.active = 1 ORDER BY e.created_at DESC LIMIT 200").map((x) => maskList(user.role_id, x)));
r("GET", "approvals", "dashboard.read", ({ url }) => { expireApprovals(); const st = url.searchParams.get("status"); return all<Record<string, unknown>>(`SELECT * FROM approvals ${st ? "WHERE status = ?" : ""} ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 200`, ...(st ? [st] : [])).map((a) => ({ ...a, evidence: J.parse(a.evidence, []) })); });
r("GET", "approvals/:id", "dashboard.read", ({ params }) => {
  const a = one<Record<string, unknown>>("SELECT * FROM approvals WHERE id = ?", params.id); if (!a) throw new HttpError(404, "Approval not found");
  let entity: unknown = null;
  if (a.entity_type === "workflow_decision") entity = one("SELECT * FROM decisions WHERE id = ?", a.entity_id);
  if (a.entity_type === "strategy_version") entity = one("SELECT * FROM strategy_versions WHERE id = ?", a.entity_id);
  if (a.entity_type === "campaign") entity = one("SELECT * FROM campaigns WHERE id = ?", a.entity_id);
  if (a.entity_type === "template") entity = one("SELECT * FROM message_templates WHERE id = ?", a.entity_id);
  if (a.entity_type === "offer_batch") entity = { summary: OFF.summarizeDecisions(all<OFF.Decision & { outcome: OFF.Outcome }>("SELECT outcome, approved_amount, reason, rules_applied rules FROM offer_decisions WHERE batch_id = ?", a.entity_id).map((d) => ({ ...d, rules: J.parse(d.rules, []) } as unknown as OFF.Decision))) };
  return { approval: { ...a, evidence: J.parse(a.evidence, []) }, history: approvalHistory(params.id), entity };
});
r("POST", "approvals/:id", "approvals.decide", async ({ req, params, user }) => {
  const b = z.object({ action: z.enum(["approve", "reject", "request_changes"]), comment: z.string().max(1000).optional() }).parse(await body(req));
  return decide(params.id, actorOf(user), b.action, b.comment);
});
r("GET", "audit", "audit.read", ({ url }) => {
  const sp = url.searchParams; const w = ["1=1"]; const p: unknown[] = [];
  for (const [k, col] of [["actor_type", "actor_type"], ["entity_type", "entity_type"], ["entity_id", "entity_id"]] as const) { const v = sp.get(k); if (v) { w.push(`${col} = ?`); p.push(v); } }
  const a = sp.get("action"); if (a) { w.push("action LIKE ?"); p.push(`${a}%`); }
  return all<Record<string, unknown>>(`SELECT * FROM audit_logs WHERE ${w.join(" AND ")} ORDER BY seq DESC LIMIT ?`, ...p, pageArgs(url).limit).map((x) => ({ ...x, details: J.parse(x.details, {}) }));
});
r("GET", "audit/verify", "audit.read", () => verifyAuditChain());

// ───────── settings ─────────
r("GET", "settings", "settings.read", () => ({
  organization: J.parse(one<{ value: string }>("SELECT value FROM settings WHERE key = 'organization'")?.value, {}),
  users: all("SELECT id, email, name, role_id, status, language, created_at FROM users"), roles: Object.entries(ROLES).map(([k, v]) => ({ id: k, ...v })), permissions: PERMISSIONS,
  ai_providers: all<Record<string, unknown>>("SELECT * FROM ai_providers").map((p) => ({ ...p, credential_configured: p.env_key ? !!process.env[String(p.env_key)] : true, env_key: p.env_key })), provider_status: providerStatus(), active_provider: activeProvider(),
  agents: all<Record<string, unknown>>("SELECT * FROM ai_agents").map((a) => ({ ...a, allowed_tools: J.parse(a.allowed_tools, []), config: J.parse(a.config, {}) })),
  data_sources: all<Record<string, unknown>>("SELECT * FROM data_sources").map((d) => ({ ...d, config: J.parse(d.config, {}) })), webhooks: all<Record<string, unknown>>("SELECT * FROM webhooks").map((w) => ({ ...w, events: J.parse(w.events, []) })),
  api_keys: all("SELECT id, name, prefix, scopes, created_by, created_at, revoked_at FROM api_keys"), flags: all("SELECT * FROM feature_flags"),
  scheduler: J.parse(one<{ value: string }>("SELECT value FROM settings WHERE key = 'scheduler'")?.value, {}), scheduled_runs: J.parse(one<{ value: string }>("SELECT value FROM settings WHERE key = 'scheduled_runs'")?.value, []),
  policy: J.parse(one<{ value: string }>("SELECT value FROM settings WHERE key = 'policy'")?.value, {}),
  health: { db: "ok", audit_chain: verifyAuditChain(), events: one("SELECT COUNT(*) n, MAX(ingested_at) last FROM events"), runs_active: one("SELECT COUNT(*) n FROM ai_workflow_runs WHERE status IN ('running','waiting_approval','paused')"), stream_backlog: one("SELECT COUNT(*) n FROM stream_events"), node: process.version, uptime_s: Math.round(process.uptime()) },
  field_mapping: Object.entries(SEG.FIELDS).map(([k, v]) => ({ field: k, ...v, source: k.includes("kyc") ? "ds_kyc" : k.includes("launch") || k.includes("load") || k.includes("search") || k.includes("session") ? "ds_events" : k.includes("ticket") ? "ds_cs" : "ds_crm" })),
}));
r("PUT", "settings/:key", "settings.write", async ({ req, params, user }) => {
  if (!["organization", "scheduler", "policy"].includes(params.key)) throw new HttpError(400, "Unknown setting");
  const b = await body(req);
  run("INSERT OR REPLACE INTO settings (key, value, updated_by, updated_at) VALUES (?,?,?,?)", params.key, J.str(b), user.email, nowIso());
  audit(actorOf(user), "settings.updated", "settings", params.key, b);
  return { ok: true };
});
r("POST", "settings/flags/:key", "settings.write", async ({ req, params, user }) => { const b = z.object({ enabled: z.boolean() }).parse(await body(req)); run("UPDATE feature_flags SET enabled = ?, updated_at = ? WHERE key = ?", b.enabled ? 1 : 0, nowIso(), params.key); audit(actorOf(user), "flag.updated", "flag", params.key, b); return { ok: true }; });
r("POST", "settings/agents/:key", "settings.write", async ({ req, params, user }) => { const b = z.object({ enabled: z.boolean() }).parse(await body(req)); run("UPDATE ai_agents SET enabled = ?, updated_at = ? WHERE key = ?", b.enabled ? 1 : 0, nowIso(), params.key); audit(actorOf(user), "agent.updated", "agent", params.key, b); return { ok: true }; });
r("POST", "settings/api-keys", "settings.write", async ({ req, user }) => {
  const b = z.object({ name: z.string().min(3), scopes: z.array(z.enum(["events.ingest"])).min(1) }).parse(await body(req));
  const raw = `aec_${id("k").slice(2)}${hashStable(String(Math.random())).slice(0, 24)}`;
  run("INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)", id("key"), ORG_ID, b.name, raw.slice(0, 10), hashStable(raw), J.str(b.scopes), user.email, nowIso());
  audit(actorOf(user), "api_key.created", "api_key", raw.slice(0, 10), { scopes: b.scopes });
  return { key: raw, note: "Shown once. Store it in your secret manager." };
});
r("POST", "settings/api-keys/:id/revoke", "settings.write", ({ params, user }) => { run("UPDATE api_keys SET revoked_at = ? WHERE id = ?", nowIso(), params.id); audit(actorOf(user), "api_key.revoked", "api_key", params.id, {}); return { ok: true }; });
r("POST", "settings/users", "settings.write", async ({ req, user }) => {
  const b = z.object({ email: z.string().email(), name: z.string().min(2), role_id: z.enum(Object.keys(ROLES) as [string]), password: z.string().min(8) }).parse(await body(req));
  const uid = id("usr");
  run("INSERT INTO users (id, org_id, email, name, password_hash, role_id, created_at) VALUES (?,?,?,?,?,?,?)", uid, ORG_ID, b.email.toLowerCase(), b.name, hashPassword(b.password), b.role_id, nowIso());
  audit(actorOf(user), "user.created", "user", uid, { email: b.email, role: b.role_id });
  return { id: uid };
});
r("PUT", "settings/users/:id", "settings.write", async ({ req, params, user }) => { const b = z.object({ role_id: z.string().optional(), status: z.enum(["active", "disabled"]).optional() }).parse(await body(req)); if (b.role_id && !ROLES[b.role_id]) throw new HttpError(400, "Unknown role"); run("UPDATE users SET role_id = COALESCE(?, role_id), status = COALESCE(?, status) WHERE id = ?", b.role_id ?? null, b.status ?? null, params.id); audit(actorOf(user), "user.updated", "user", params.id, b); return { ok: true }; });
r("POST", "settings/data-sources/:id/sync", "settings.write", ({ params, user }) => { run("UPDATE data_sources SET last_sync_at = ? WHERE id = ?", nowIso(), params.id); audit(actorOf(user), "data_source.sync", "data_source", params.id, { mode: "mock" }); notify("system", "Data source synced (mock)", params.id, "/settings?tab=data", "info"); return { ok: true, mode: "mock" }; });

// ───────── dispatcher ─────────
function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/"), b = path.split("/");
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) { if (a[i].startsWith(":")) params[a[i].slice(1)] = decodeURIComponent(b[i]); else if (a[i] !== b[i]) return null; }
  return params;
}

async function apiKeyUser(req: Request): Promise<SessionUser | null> {
  const key = req.headers.get("x-api-key");
  if (!key) return null;
  const k = one<{ id: string; scopes: string; revoked_at: string | null; name: string }>("SELECT * FROM api_keys WHERE key_hash = ?", hashStable(key));
  if (!k || k.revoked_at) throw new HttpError(401, "Invalid API key");
  if (!J.parse<string[]>(k.scopes, []).includes("events.ingest")) throw new HttpError(403, "API key lacks scope");
  return { id: `apikey:${k.id}`, email: `apikey:${k.name}`, name: k.name, role_id: "__ingest", org_id: ORG_ID, language: "en" };
}
ROLES.__ingest = { name: "Ingestion API key", description: "events.ingest only", permissions: ["events.ingest"] };

export async function dispatch(req: Request, path: string): Promise<unknown> {
  const method = req.method.toUpperCase();
  for (const rt of routes) {
    if (rt.method !== method) continue;
    const params = match(rt.pattern, path);
    if (!params) continue;
    const url = new URL(req.url);
    if (rt.public) return rt.handler({ req, url, params, user: null as unknown as SessionUser });
    const keyUser = path === "events" && method === "POST" ? await apiKeyUser(req) : null;
    const user = keyUser ?? (await currentUser());
    if (!user) throw new HttpError(401, "Not authenticated");
    if (!keyUser && method !== "GET") {
      const origin = req.headers.get("origin"); const host = req.headers.get("host");
      if (origin && host && new URL(origin).host !== host) throw new HttpError(403, "Cross-origin request blocked (CSRF)");
      rateLimit(`u:${user.id}`, 600);
    }
    if (rt.perm && !can(user.role_id, rt.perm)) throw new HttpError(403, `Missing permission: ${rt.perm}`);
    return rt.handler({ req, url, params, user });
  }
  throw new HttpError(404, `No route ${method} /api/${path}`);
}
export const ROUTES = () => routes.map((x) => ({ method: x.method, path: `/api/${x.pattern}`, permission: x.perm ?? (x.public ? "public" : "authenticated") }));
