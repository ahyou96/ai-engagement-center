import { all, one, J } from "./db";
import { nowDate, pct, round, daysAgo } from "./util";
import { channelStats } from "./messaging";

/**
 * Overview + analytics metrics. Every metric is computed from the shared tables at query time and
 * carries a documented definition and formula (also listed in docs/DATA_DICTIONARY.md).
 */
export type Filters = { from: string; to: string; platform?: string; provider?: string; channel?: string; segment?: string; campaign?: string };
export type Metric = { key: string; label: string; value: number | null; prev?: number | null; format: "int" | "pct" | "money" | "ms" | "float"; definition: string; formula: string; source: string };

export function parseFilters(sp: URLSearchParams): Filters {
  const days = Number(sp.get("days") ?? 7);
  const to = sp.get("to") ?? nowDate().toISOString();
  const from = sp.get("from") ?? new Date(new Date(to).getTime() - days * 86400_000).toISOString();
  const f: Filters = { from, to };
  for (const k of ["platform", "provider", "channel", "segment", "campaign"] as const) { const v = sp.get(k); if (v) f[k] = v; }
  return f;
}
function prevRange(f: Filters): Filters { const span = new Date(f.to).getTime() - new Date(f.from).getTime(); return { ...f, from: new Date(new Date(f.from).getTime() - span).toISOString(), to: f.from }; }

function custWhere(f: Filters, alias = "c") {
  const w: string[] = [`${alias}.org_id = 'org_demo'`]; const p: unknown[] = [];
  if (f.platform) { w.push(`${alias}.primary_platform = ?`); p.push(f.platform); }
  if (f.segment) { w.push(`EXISTS (SELECT 1 FROM segment_memberships sm WHERE sm.player_id = ${alias}.player_id AND sm.segment_id = ?)`); p.push(f.segment); }
  return { w: w.join(" AND "), p };
}
function evWhere(f: Filters, alias = "e") {
  const w: string[] = [`${alias}.event_time >= ?`, `${alias}.event_time < ?`]; const p: unknown[] = [f.from, f.to];
  if (f.platform) { w.push(`${alias}.platform = ?`); p.push(f.platform); }
  if (f.provider) { w.push(`${alias}.provider_id = ?`); p.push(f.provider); }
  if (f.segment) { w.push(`EXISTS (SELECT 1 FROM segment_memberships sm WHERE sm.player_id = ${alias}.player_id AND sm.segment_id = ?)`); p.push(f.segment); }
  return { w: w.join(" AND "), p };
}
function msgWhere(f: Filters, alias = "m") {
  const w: string[] = [`${alias}.created_at >= ?`, `${alias}.created_at < ?`]; const p: unknown[] = [f.from, f.to];
  if (f.channel) { w.push(`${alias}.channel = ?`); p.push(f.channel); }
  if (f.campaign) { w.push(`${alias}.campaign_id = ?`); p.push(f.campaign); }
  if (f.segment) { w.push(`EXISTS (SELECT 1 FROM segment_memberships sm WHERE sm.player_id = ${alias}.player_id AND sm.segment_id = ?)`); p.push(f.segment); }
  return { w: w.join(" AND "), p };
}

function customerMetrics(f: Filters): Metric[] {
  const c = custWhere(f);
  const total = one<{ n: number }>(`SELECT COUNT(*) n FROM customers c WHERE ${c.w}`, ...c.p)!.n;
  const actBetween = (from: string, to: string) => one<{ n: number }>(`SELECT COUNT(DISTINCT e.player_id) n FROM events e JOIN customers c ON c.player_id = e.player_id WHERE ${c.w} AND e.event_time >= ? AND e.event_time < ?`, ...c.p, from, to)!.n;
  const to = f.to;
  const dau = actBetween(new Date(new Date(to).getTime() - 86400_000).toISOString(), to);
  const wau = actBetween(new Date(new Date(to).getTime() - 7 * 86400_000).toISOString(), to);
  const mau = actBetween(new Date(new Date(to).getTime() - 30 * 86400_000).toISOString(), to);
  const regs = (r: Filters) => one<{ n: number }>(`SELECT COUNT(*) n FROM customers c WHERE ${c.w} AND c.registered_at >= ? AND c.registered_at < ?`, ...c.p, r.from, r.to)!.n;
  const kyc = one<{ v: number; n: number }>(`SELECT SUM(CASE WHEN kyc_status = 'verified' THEN 1 ELSE 0 END) v, COUNT(*) n FROM customers c WHERE ${c.w}`, ...c.p)!;
  const compl = one<{ a: number }>(`SELECT AVG(profile_completeness) a FROM customers c WHERE ${c.w}`, ...c.p)!.a;
  const reachable = one<{ n: number }>(`SELECT COUNT(*) n FROM customers c WHERE ${c.w} AND c.account_status = 'active' AND EXISTS (SELECT 1 FROM consent_current cc WHERE cc.player_id = c.player_id AND cc.granted = 1 AND cc.channel != 'inbox')`, ...c.p)!.n;
  const mkConsent = one<{ n: number }>(`SELECT COUNT(DISTINCT cc.player_id) n FROM consent_current cc JOIN customers c ON c.player_id = cc.player_id WHERE ${c.w} AND cc.purpose = 'marketing' AND cc.granted = 1`, ...c.p)!.n;
  return [
    { key: "total_users", label: "Total registered users", value: total, format: "int", definition: "All customer profiles in the tenant", formula: "COUNT(customers)", source: "customers" },
    { key: "dau", label: "DAU", value: dau, format: "int", definition: "Distinct players with ≥1 event in the 24h before the end of the range", formula: "COUNT(DISTINCT events.player_id) over [to-1d, to)", source: "events" },
    { key: "wau", label: "WAU", value: wau, format: "int", definition: "Distinct players with ≥1 event in 7 days", formula: "COUNT(DISTINCT player_id) over [to-7d, to)", source: "events" },
    { key: "mau", label: "MAU", value: mau, format: "int", definition: "Distinct players with ≥1 event in 30 days", formula: "COUNT(DISTINCT player_id) over [to-30d, to)", source: "events" },
    { key: "new_registrations", label: "New registrations", value: regs(f), prev: regs(prevRange(f)), format: "int", definition: "Profiles registered in the range", formula: "COUNT(customers WHERE registered_at IN range)", source: "customers" },
    { key: "kyc_rate", label: "KYC completion", value: kyc.n ? kyc.v / kyc.n : 0, format: "pct", definition: "Share of profiles with verified KYC", formula: "verified / all profiles", source: "customers.kyc_status" },
    { key: "profile_completeness", label: "Profile completeness", value: compl ?? 0, format: "pct", definition: "Average share of populated profile fields", formula: "AVG(profile_completeness)", source: "customers" },
    { key: "reachable", label: "Reachable users", value: reachable, format: "int", definition: "Active accounts with ≥1 consented external channel", formula: "COUNT(active ∧ ∃ consent granted on non-inbox channel)", source: "consent_current" },
    { key: "marketing_consent", label: "Marketing consent coverage", value: total ? mkConsent / total : 0, format: "pct", definition: "Profiles with marketing consent on ≥1 channel", formula: "COUNT(DISTINCT marketing consent) / total", source: "consent_current" },
  ];
}

function gamingMetrics(f: Filters): Metric[] {
  const e = evWhere(f); const pe = evWhere(prevRange(f));
  const q = (w: { w: string; p: unknown[] }) => one<{ players: number; ok: number; fail: number; load: number; search: number; nores: number; sessions: number; disc: number; err: number; cs: number }>(`SELECT
    COUNT(DISTINCT CASE WHEN e.event_name = 'game_session_start' THEN e.player_id END) players,
    SUM(e.event_name = 'game_launch_success') ok, SUM(e.event_name = 'game_launch_failed') fail,
    AVG(CASE WHEN e.event_name IN ('game_launch_success') THEN e.loading_duration END) load,
    SUM(e.event_name IN ('game_search','game_search_no_result')) search, SUM(e.event_name = 'game_search_no_result') nores,
    SUM(e.event_name = 'game_session_start') sessions, SUM(e.event_name = 'game_disconnect') disc, SUM(e.event_name = 'game_error') err, SUM(e.event_name = 'game_cs_click') cs
    FROM events e WHERE ${w.w}`, ...w.p)!;
  const a = q(e), b = q(pe);
  const rate = (x: typeof a) => (x.ok + x.fail ? x.ok / (x.ok + x.fail) : null);
  const rg = one<{ n: number }>("SELECT COUNT(*) n FROM exclusion_records WHERE active = 1 AND exclusion_type IN ('self_exclusion','rg_restriction')")!.n;
  return [
    { key: "gaming_active", label: "Gaming active users", value: a.players, prev: b.players, format: "int", definition: "Distinct players who started ≥1 game session", formula: "COUNT(DISTINCT player_id WHERE game_session_start)", source: "events" },
    { key: "launch_success", label: "Game launch success rate", value: rate(a), prev: rate(b), format: "pct", definition: "Successful launches over launch outcomes", formula: "launch_success / (launch_success + launch_failed)", source: "events" },
    { key: "avg_load", label: "Avg loading time", value: a.load ? Math.round(a.load) : null, prev: b.load ? Math.round(b.load) : null, format: "ms", definition: "Mean loading_duration of successful launches", formula: "AVG(loading_duration | launch_success)", source: "events" },
    { key: "sessions", label: "Game sessions", value: a.sessions, prev: b.sessions, format: "int", definition: "Game sessions started", formula: "COUNT(game_session_start)", source: "events" },
    { key: "search_success", label: "Game search success", value: a.search ? 1 - a.nores / a.search : null, prev: b.search ? 1 - b.nores / b.search : null, format: "pct", definition: "Searches returning ≥1 result", formula: "1 − no_result / searches", source: "events" },
    { key: "gaming_error_rate", label: "Gaming error rate", value: a.sessions ? (a.disc + a.err) / a.sessions : null, prev: b.sessions ? (b.disc + b.err) / b.sessions : null, format: "pct", definition: "Disconnects + in-game errors per session", formula: "(game_disconnect + game_error) / sessions", source: "events" },
    { key: "gaming_cs", label: "In-game CS contacts", value: a.cs, prev: b.cs, format: "int", definition: "Customer service opened from inside a game", formula: "COUNT(game_cs_click)", source: "events" },
    { key: "rg_active", label: "Active RG protections", value: rg, format: "int", definition: "Players under self-exclusion or RG restriction (protective indicator, not a target)", formula: "COUNT(active exclusion_records of RG types)", source: "exclusion_records" },
  ];
}

function engagementMetrics(f: Filters): Metric[] {
  const m = msgWhere(f); const pm = msgWhere(prevRange(f));
  const q = (w: { w: string; p: unknown[] }) => one<{ n: number; u: number; d: number; r: number; c: number; cost: number }>(`SELECT COUNT(*) n, COUNT(DISTINCT player_id) u, SUM(status IN ('delivered','read','clicked')) d, SUM(status IN ('read','clicked')) r, SUM(status = 'clicked') c, SUM(cost) cost FROM messages m WHERE ${w.w}`, ...w.p)!;
  const a = q(m), b = q(pm);
  const jr = one<{ n: number; done: number }>("SELECT COUNT(*) n, SUM(status IN ('completed','exited')) done FROM journey_executions WHERE started_at >= ? AND started_at < ?", f.from, f.to)!;
  const svc = one<{ n: number; r: number }>("SELECT COUNT(*) n, SUM(status = 'resolved') r FROM service_tickets WHERE created_at >= ? AND created_at < ?", f.from, f.to)!;
  const camps = one<{ n: number }>("SELECT COUNT(*) n FROM campaigns WHERE status = 'completed' AND updated_at >= ? AND updated_at < ?", f.from, f.to)!.n;
  return [
    { key: "messages_sent", label: "Messages sent", value: a.n, prev: b.n, format: "int", definition: "Outbound messages created (mock sending)", formula: "COUNT(messages)", source: "messages" },
    { key: "unique_reached", label: "Unique users reached", value: a.u, prev: b.u, format: "int", definition: "Distinct recipients", formula: "COUNT(DISTINCT player_id)", source: "messages" },
    { key: "delivery_rate", label: "Delivery rate", value: a.n ? a.d / a.n : null, prev: b.n ? b.d / b.n : null, format: "pct", definition: "Messages reaching delivered/read/clicked", formula: "delivered⁺ / sent", source: "messages, delivery_events" },
    { key: "read_rate", label: "Read rate", value: a.d ? a.r / a.d : null, prev: b.d ? b.r / b.d : null, format: "pct", definition: "Read over delivered", formula: "read⁺ / delivered⁺", source: "delivery_events" },
    { key: "ctr", label: "Click-through rate", value: a.d ? a.c / a.d : null, prev: b.d ? b.c / b.d : null, format: "pct", definition: "Clicked over delivered", formula: "clicked / delivered⁺", source: "delivery_events" },
    { key: "service_completion", label: "Service completion", value: svc.n ? svc.r / svc.n : null, format: "pct", definition: "Tickets created in range that are resolved", formula: "resolved / created", source: "service_tickets" },
    { key: "channel_cost", label: "Channel cost (PHP)", value: round(a.cost ?? 0), prev: round(b.cost ?? 0), format: "money", definition: "Sum of per-message cost", formula: "SUM(messages.cost)", source: "messages" },
    { key: "campaigns_completed", label: "Campaigns completed", value: camps, format: "int", definition: "Campaigns executed in range", formula: "COUNT(campaigns completed)", source: "campaigns" },
    { key: "journey_completion", label: "Journey completion", value: jr.n ? jr.done / jr.n : null, format: "pct", definition: "Journey executions completed or exited by rule", formula: "(completed + exited) / started", source: "journey_executions" },
  ];
}

function aiMetrics(f: Filters): Metric[] {
  const r = one<{ running: number; done: number; failed: number; total: number; cost: number; tokens: number }>(`SELECT SUM(status IN ('running','waiting_approval','paused')) running, SUM(status = 'completed') done, SUM(status = 'failed') failed, COUNT(*) total, SUM(cost) cost, SUM(tokens) tokens FROM ai_workflow_runs WHERE started_at >= ? AND started_at < ?`, f.from, f.to)!;
  const opps = one<{ n: number }>("SELECT COUNT(*) n FROM opportunities WHERE detected_at >= ? AND detected_at < ?", f.from, f.to)!.n;
  const pendDec = one<{ n: number }>("SELECT COUNT(*) n FROM decisions WHERE status = 'pending'")!.n;
  const pendApr = one<{ n: number }>("SELECT COUNT(*) n FROM approvals WHERE status = 'pending'")!.n;
  const optimized = one<{ n: number }>("SELECT COUNT(*) n FROM strategy_versions WHERE created_by = 'agent:optimizer' AND created_at >= ? AND created_at < ?", f.from, f.to)!.n;
  const tools = one<{ n: number }>("SELECT COUNT(*) n FROM ai_tool_calls WHERE at >= ? AND at < ?", f.from, f.to)!.n;
  return [
    { key: "ai_running", label: "Running AI tasks", value: r.running ?? 0, format: "int", definition: "Runs running, paused or awaiting approval", formula: "COUNT(runs in active states)", source: "ai_workflow_runs" },
    { key: "opps", label: "Opportunities discovered", value: opps, format: "int", definition: "Opportunities detected in range", formula: "COUNT(opportunities)", source: "opportunities" },
    { key: "pending_decisions", label: "Pending decisions", value: pendDec, format: "int", definition: "Agent proposals awaiting a decision", formula: "COUNT(decisions pending)", source: "decisions" },
    { key: "pending_approvals", label: "Pending approvals", value: pendApr, format: "int", definition: "All approvals awaiting a human", formula: "COUNT(approvals pending)", source: "approvals" },
    { key: "workflows_done", label: "Completed workflows", value: r.done ?? 0, format: "int", definition: "Runs completed in range", formula: "COUNT(runs completed)", source: "ai_workflow_runs" },
    { key: "optimized", label: "Optimized strategies", value: optimized, format: "int", definition: "Candidate versions generated by the optimizer", formula: "COUNT(strategy_versions by optimizer)", source: "strategy_versions" },
    { key: "ai_success", label: "AI execution success", value: r.total ? (r.done ?? 0) / r.total : null, format: "pct", definition: "Completed over all runs in range", formula: "completed / runs", source: "ai_workflow_runs" },
    { key: "ai_cost", label: "AI operating cost (est.)", value: round(r.cost ?? 0, 4), format: "money", definition: "Estimated token cost (mock pricing; see Settings)", formula: "Σ tokens × blended rate", source: "ai_node_executions" },
    { key: "workload", label: "Est. manual workload saved (h)", value: round((tools * 4) / 60, 1), format: "float", definition: "ESTIMATE: 4 analyst-minutes per automated tool call — an assumption, not a measurement", formula: "tool_calls × 4 min / 60", source: "ai_tool_calls (assumption)" },
  ];
}

function offerMetrics(f: Filters): Metric[] {
  const d = one<{ n: number; e: number }>("SELECT COUNT(*) n, SUM(outcome != 'none') e FROM offer_decisions WHERE simulated = 0 AND created_at >= ? AND created_at < ?", f.from, f.to)!;
  const t = one<{ issued: number; claimed: number; redeemed: number }>("SELECT COUNT(*) issued, SUM(status IN ('claimed','redeemed')) claimed, SUM(status = 'redeemed') redeemed FROM offer_transactions WHERE created_at >= ? AND created_at < ?", f.from, f.to)!;
  const b = one<{ total: number; used: number }>("SELECT SUM(total) total, SUM(reserved + spent) used FROM offer_budgets WHERE scope = 'offer'")!;
  const dup = one<{ n: number }>("SELECT COUNT(*) n FROM duplicate_prevention_log WHERE kind = 'offer' AND at >= ? AND at < ?", f.from, f.to)!.n;
  const comp = one<{ n: number }>("SELECT COUNT(*) n FROM service_tickets WHERE category = 'promotion_question' AND created_at >= ? AND created_at < ?", f.from, f.to)!.n;
  return [
    { key: "eligible", label: "Eligible users", value: d.e ?? 0, format: "int", definition: "Non-simulated decisions with an outcome other than No Offer", formula: "COUNT(offer_decisions outcome≠none)", source: "offer_decisions" },
    { key: "issued", label: "Entitlements issued", value: t.issued, format: "int", definition: "Transactions created (mock wallet)", formula: "COUNT(offer_transactions)", source: "offer_transactions" },
    { key: "claimed", label: "Claimed", value: t.claimed ?? 0, format: "int", definition: "Issued entitlements claimed or redeemed", formula: "COUNT(status ∈ claimed, redeemed)", source: "offer_transactions" },
    { key: "redeemed", label: "Redeemed", value: t.redeemed ?? 0, format: "int", definition: "Redeemed entitlements", formula: "COUNT(status = redeemed)", source: "offer_transactions" },
    { key: "budget_util", label: "Budget utilization", value: b.total ? b.used / b.total : 0, format: "pct", definition: "Reserved + spent over total of offer budgets", formula: "Σ(reserved+spent) / Σ total", source: "offer_budgets" },
    { key: "dup_prevented", label: "Duplicate issuances prevented", value: dup, format: "int", definition: "Issuance attempts blocked by idempotency / per-user limits", formula: "COUNT(duplicate_prevention_log kind=offer)", source: "duplicate_prevention_log" },
    { key: "offer_complaints", label: "Offer-related complaints", value: comp, format: "int", definition: "Service tickets categorised promotion_question", formula: "COUNT(tickets category=promotion_question)", source: "service_tickets" },
  ];
}

export function overview(f: Filters) {
  const t0 = Date.now();
  const out = { customer: customerMetrics(f), gaming: gamingMetrics(f), engagement: engagementMetrics(f), ai: aiMetrics(f), offers: offerMetrics(f) };
  return { filters: f, ...out, charts: overviewCharts(f), insights: insights(), freshness: freshness(), computed_ms: Date.now() - t0 };
}

export function overviewCharts(f: Filters) {
  const e = evWhere(f);
  const daily = all(`SELECT substr(e.event_time,1,10) d, COUNT(DISTINCT e.player_id) active, SUM(e.event_name = 'game_launch_success') ok, SUM(e.event_name = 'game_launch_failed') fail FROM events e WHERE ${e.w} GROUP BY d ORDER BY d`, ...e.p);
  const m = msgWhere(f);
  const msgs = all(`SELECT substr(m.created_at,1,10) d, COUNT(*) sent, SUM(status IN ('delivered','read','clicked')) delivered FROM messages m WHERE ${m.w} GROUP BY d ORDER BY d`, ...m.p);
  const lifecycle = all(`SELECT lifecycle_stage k, COUNT(*) n FROM customers c WHERE ${custWhere(f).w} GROUP BY k ORDER BY n DESC`, ...custWhere(f).p);
  const providers = all(`SELECT p.id, p.name, COUNT(*) launches, SUM(e.event_name = 'game_launch_failed') failures, ROUND(AVG(e.loading_duration)) avg_load FROM events e JOIN gaming_providers p ON p.id = e.provider_id WHERE ${e.w} AND e.event_name IN ('game_launch_success','game_launch_failed') GROUP BY p.id ORDER BY 1.0 * SUM(e.event_name = 'game_launch_failed') / COUNT(*) DESC`, ...e.p);
  const channels = channelStats((new Date(f.to).getTime() - new Date(f.from).getTime()) / 3600_000);
  const sessions = all(`SELECT CASE WHEN duration_minutes < 5 THEN '<5m' WHEN duration_minutes < 15 THEN '5–15m' WHEN duration_minutes < 30 THEN '15–30m' WHEN duration_minutes < 60 THEN '30–60m' ELSE '60m+' END k, COUNT(*) n FROM gaming_sessions WHERE started_at >= ? AND started_at < ? ${f.platform ? "AND platform = ?" : ""} GROUP BY k`, f.from, f.to, ...(f.platform ? [f.platform] : []));
  return { daily, msgs, lifecycle, providers, channels, sessions };
}

export function insights() {
  const out: Array<{ severity: string; title: string; body: string; link: string; kind: "verified" | "estimate" }> = [];
  const prov = all<{ name: string; id: string; l: number; f: number }>(`SELECT p.name, p.id, COUNT(*) l, SUM(e.event_name = 'game_launch_failed') f FROM events e JOIN gaming_providers p ON p.id = e.provider_id WHERE e.event_time >= ? AND e.event_name IN ('game_launch_success','game_launch_failed') GROUP BY p.id HAVING l >= 40 ORDER BY 1.0*f/l DESC LIMIT 1`, new Date(nowDate().getTime() - 24 * 3600_000).toISOString());
  if (prov[0] && prov[0].f / prov[0].l > 0.08) out.push({ severity: "critical", title: `${prov[0].name}: ${pct(prov[0].f, prov[0].l)}% launch failures (24h)`, body: `${prov[0].f} of ${prov[0].l} launches failed. Run the Provider Failure workflow.`, link: `/opportunities?scenario=provider_failure`, kind: "verified" });
  const sms = one<{ n: number; d: number }>("SELECT COUNT(*) n, SUM(status IN ('delivered','read','clicked')) d FROM messages WHERE channel = 'sms' AND created_at >= ?", new Date(nowDate().getTime() - 24 * 3600_000).toISOString())!;
  if (sms.n > 50 && sms.d / sms.n < 0.9) out.push({ severity: "warning", title: `SMS delivery ${pct(sms.d, sms.n)}% (24h)`, body: "Below 90% target; consented fallbacks available.", link: "/opportunities?scenario=channel_delivery", kind: "verified" });
  const kyc = one<{ n: number }>("SELECT COUNT(*) n FROM customers WHERE kyc_status IN ('pending','failed') AND kyc_updated_at < ?", daysAgo(1))!.n;
  if (kyc > 50) out.push({ severity: "warning", title: `${kyc.toLocaleString()} players stalled in KYC`, body: "Top reason: blurry documents. KYC Assistance workflow available.", link: "/opportunities?scenario=kyc_assistance", kind: "verified" });
  const pend = one<{ n: number }>("SELECT COUNT(*) n FROM approvals WHERE status = 'pending'")!.n;
  if (pend) out.push({ severity: "info", title: `${pend} approval(s) waiting`, body: "Review in the Approval Center.", link: "/compliance?tab=approvals", kind: "verified" });
  const ios = one<{ n: number }>("SELECT COUNT(*) n FROM customers WHERE os = 'ios' AND avg_load_ms > 5000")!.n;
  if (ios > 20) out.push({ severity: "info", title: `${ios} iOS players average >5s game loading`, body: "Correlated with one provider on iOS — correlation only; confirm with provider before acting.", link: "/analytics?tab=gaming", kind: "estimate" });
  return out;
}

export function freshness() {
  return all<{ id: string; name: string; last_sync_at: string; freshness_minutes: number; mode: string }>("SELECT id, name, last_sync_at, freshness_minutes, mode FROM data_sources ORDER BY name").concat([{ id: "events_live", name: "Latest ingested event", last_sync_at: one<{ t: string }>("SELECT MAX(ingested_at) t FROM events")!.t, freshness_minutes: 0, mode: "live" }]);
}

// ───────── Analytics ─────────
export function gamingFunnel(f: Filters) {
  const e = evWhere(f);
  const steps = ["game_impression", "game_click", "game_launch_start", "game_launch_success", "game_session_start"];
  const r = one<Record<string, number>>(`SELECT ${steps.map((s) => `COUNT(DISTINCT CASE WHEN e.event_name = '${s}' THEN e.player_id END) "${s}"`).join(", ")} FROM events e WHERE ${e.w}`, ...e.p)!;
  const byEntry = all(`SELECT entry_source k, COUNT(*) clicks FROM events e WHERE ${e.w} AND e.event_name = 'game_click' GROUP BY k ORDER BY clicks DESC`, ...e.p);
  const errors = all(`SELECT error_code k, COUNT(*) n FROM events e WHERE ${e.w} AND e.event_name = 'game_launch_failed' GROUP BY k ORDER BY n DESC`, ...e.p);
  const byOs = all(`SELECT operating_system k, SUM(event_name = 'game_launch_failed') fail, COUNT(*) n, ROUND(AVG(loading_duration)) load FROM events e WHERE ${e.w} AND e.event_name IN ('game_launch_success','game_launch_failed') GROUP BY k`, ...e.p);
  const categories = all(`SELECT g.category k, COUNT(*) sessions FROM gaming_sessions s JOIN games g ON g.id = s.game_id WHERE s.started_at >= ? AND s.started_at < ? GROUP BY k ORDER BY sessions DESC`, f.from, f.to);
  const topGames = all(`SELECT g.name, p.name provider, COUNT(*) sessions FROM gaming_sessions s JOIN games g ON g.id = s.game_id JOIN gaming_providers p ON p.id = g.provider_id WHERE s.started_at >= ? AND s.started_at < ? GROUP BY g.id ORDER BY sessions DESC LIMIT 10`, f.from, f.to);
  const searches = all(`SELECT json_extract(properties,'$.keyword') k, SUM(event_name = 'game_search_no_result') none, COUNT(*) n FROM events e WHERE ${e.w} AND e.event_name IN ('game_search','game_search_no_result') GROUP BY k ORDER BY n DESC LIMIT 15`, ...e.p);
  return { funnel: steps.map((s) => ({ step: s, players: r[s] })), byEntry, errors, byOs, categories, topGames, searches };
}

export function cohorts(weeks = 8) {
  const rows = all<{ cohort: string; wk: number; n: number }>(`WITH c AS (SELECT player_id, strftime('%Y-%W', registered_at) cohort, registered_at FROM customers WHERE registered_at >= ?)
    SELECT c.cohort, CAST((julianday(e.event_time) - julianday(c.registered_at)) / 7 AS INTEGER) wk, COUNT(DISTINCT e.player_id) n FROM c JOIN events e ON e.player_id = c.player_id WHERE e.event_time >= c.registered_at GROUP BY c.cohort, wk`, daysAgo(weeks * 7));
  const sizes = all<{ cohort: string; n: number }>("SELECT strftime('%Y-%W', registered_at) cohort, COUNT(*) n FROM customers WHERE registered_at >= ? GROUP BY cohort ORDER BY cohort", daysAgo(weeks * 7));
  return { sizes, rows, note: "Retention = distinct cohort players with any event in week k after registration ÷ cohort size. Synthetic data." };
}

/** Last-touch attribution with explicit correlation caveat; causal claims only from A/B variants. */
export function attribution(f: Filters) {
  const rows = all(`SELECT c.id, c.name, c.purpose, COUNT(DISTINCT m.player_id) reached,
    COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM gaming_sessions s WHERE s.player_id = m.player_id AND s.started_at > m.created_at AND s.started_at < datetime(m.created_at, '+3 days')) THEN m.player_id END) active_after
    FROM campaigns c JOIN messages m ON m.campaign_id = c.id WHERE m.created_at >= ? AND m.created_at < ? GROUP BY c.id ORDER BY reached DESC`, f.from, f.to);
  const ab = all(`SELECT m.campaign_id, c.name, m.variant, COUNT(*) n, SUM(m.status = 'clicked') clicks, SUM(m.status IN ('read','clicked')) reads FROM messages m JOIN campaigns c ON c.id = m.campaign_id WHERE m.variant IS NOT NULL GROUP BY m.campaign_id, m.variant`);
  return { rows, ab, caveat: "Activity after a message is CORRELATION, not incremental lift. Only randomized A/B variants (and strategy experiments with holdouts) support causal statements." };
}

export function costAnalysis(f: Filters) {
  const ch = all(`SELECT channel, COUNT(*) n, ROUND(SUM(cost),2) cost, ROUND(SUM(cost) / NULLIF(SUM(status IN ('delivered','read','clicked')),0), 4) cost_per_delivered FROM messages WHERE created_at >= ? AND created_at < ? GROUP BY channel ORDER BY cost DESC`, f.from, f.to);
  const ai = all(`SELECT w.name, COUNT(*) runs, ROUND(SUM(r.cost),4) cost, SUM(r.tokens) tokens FROM ai_workflow_runs r JOIN ai_workflows w ON w.id = r.workflow_id WHERE r.started_at >= ? AND r.started_at < ? GROUP BY w.id`, f.from, f.to);
  const offers = all(`SELECT o.name, COUNT(t.id) issued, ROUND(SUM(t.amount),2) amount FROM offer_transactions t JOIN offers o ON o.id = t.offer_id WHERE t.created_at >= ? AND t.created_at < ? GROUP BY o.id`, f.from, f.to);
  return { channels: ch, ai, offers };
}

export function csAnalytics(f: Filters) {
  return {
    byCategory: all("SELECT category k, COUNT(*) n, SUM(status = 'resolved') resolved, ROUND(AVG(CASE WHEN resolved_at IS NOT NULL THEN (julianday(created_at) - julianday(resolved_at)) * -24 END),1) avg_hours FROM service_tickets WHERE created_at >= ? AND created_at < ? GROUP BY k ORDER BY n DESC", f.from, f.to),
    daily: all("SELECT substr(created_at,1,10) d, COUNT(*) n FROM service_tickets WHERE created_at >= ? AND created_at < ? GROUP BY d ORDER BY d", f.from, f.to),
    open: one<{ n: number }>("SELECT COUNT(*) n FROM service_tickets WHERE status IN ('open','pending')")!.n,
  };
}

export function aiPerformance(f: Filters) {
  return {
    byWorkflow: all(`SELECT w.name, COUNT(*) runs, SUM(r.status = 'completed') completed, SUM(r.status = 'failed') failed, SUM(r.status = 'waiting_approval') waiting, ROUND(AVG((julianday(COALESCE(r.finished_at, r.updated_at)) - julianday(r.started_at)) * 86400), 1) avg_seconds, ROUND(SUM(r.cost),4) cost FROM ai_workflow_runs r JOIN ai_workflows w ON w.id = r.workflow_id WHERE r.started_at >= ? GROUP BY w.id`, f.from),
    byAgent: all(`SELECT agent_key, COUNT(*) n, SUM(status = 'completed') ok, SUM(status = 'failed') failed, ROUND(AVG(duration_ms)) avg_ms, ROUND(AVG(confidence),2) avg_conf, SUM(tokens) tokens FROM ai_node_executions WHERE started_at >= ? GROUP BY agent_key`, f.from),
    tools: all(`SELECT tool, COUNT(*) n, SUM(status = 'failed') failed, ROUND(AVG(duration_ms)) avg_ms FROM ai_tool_calls WHERE at >= ? GROUP BY tool ORDER BY n DESC`, f.from),
  };
}

export function strategyPerformance() {
  return all(`SELECT s.name, s.category, v.version, v.status, v.change_summary, v.created_at, v.baseline_metrics, v.candidate_metrics, (SELECT p_value FROM experiment_results r WHERE r.experiment_id = v.experiment_id AND r.variant = 'candidate') p_value FROM strategy_versions v JOIN strategies s ON s.id = v.strategy_id ORDER BY s.name, v.version`)
    .map((r) => ({ ...(r as Record<string, unknown>), baseline_metrics: J.parse((r as { baseline_metrics: string }).baseline_metrics, null), candidate_metrics: J.parse((r as { candidate_metrics: string }).candidate_metrics, null) }));
}

export function complianceAnalytics(f: Filters) {
  return {
    byPolicy: all<{ reasons: string }>("SELECT reasons FROM compliance_checks WHERE player_id IS NULL AND at >= ? AND at < ?", f.from, f.to).reduce((acc, r) => { const x = J.parse<{ by_policy?: Record<string, number> }>(r.reasons, {}); for (const [k, v] of Object.entries(x.by_policy ?? {})) acc[k] = (acc[k] ?? 0) + v; return acc; }, {} as Record<string, number>),
    checks: one("SELECT COUNT(*) n, SUM(allowed = 0) blocked FROM compliance_checks WHERE player_id IS NULL AND at >= ? AND at < ?", f.from, f.to),
    exclusions: all("SELECT exclusion_type k, COUNT(*) n FROM exclusion_records WHERE active = 1 GROUP BY k"),
    approvals: all("SELECT status k, COUNT(*) n FROM approvals GROUP BY k"),
  };
}

export function segmentAnalytics() {
  return all("SELECT s.id, s.name, s.purpose, s.segment_type, s.member_count, (SELECT COUNT(*) FROM segment_membership_history h WHERE h.segment_id = s.id AND h.action = 'enter' AND h.at >= ?) entered_7d, (SELECT COUNT(*) FROM segment_membership_history h WHERE h.segment_id = s.id AND h.action = 'exit' AND h.at >= ?) exited_7d FROM segments s ORDER BY s.member_count DESC", daysAgo(7), daysAgo(7));
}

export function offerAnalytics() {
  return {
    distribution: all("SELECT o.name, d.outcome, COUNT(*) n FROM offer_decisions d JOIN offers o ON o.id = d.offer_id WHERE d.simulated = 0 GROUP BY o.name, d.outcome"),
    lifecycle: all("SELECT o.name, t.status, COUNT(*) n, SUM(t.amount) amount FROM offer_transactions t JOIN offers o ON o.id = t.offer_id GROUP BY o.name, t.status"),
    fairness: all("SELECT c.vip_tier, d.outcome, COUNT(*) n FROM offer_decisions d JOIN customers c ON c.player_id = d.player_id WHERE d.simulated = 0 GROUP BY c.vip_tier, d.outcome"),
    budgets: all("SELECT * FROM offer_budgets"),
    duplicates: one("SELECT COUNT(*) n FROM duplicate_prevention_log WHERE kind = 'offer'"),
  };
}
