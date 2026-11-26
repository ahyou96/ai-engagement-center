import { all, J, one, run } from "../db";
import { evaluate, summarize, validateContent, Purpose } from "../compliance";
import { createSegment, estimate, evaluateSegment, matchIds, Rule } from "../segments";
import { decideForPlayers, runBatch, summarizeDecisions, issueBatch, transition } from "../offers";
import { sendMessages } from "../messaging";
import { publishJourney, enroll, simulate as simulateJourney, getJourney, JourneyDef } from "../journeys";
import { createCandidate, evaluateCandidate, submitForApproval, recordExecutionResult, getStrategy } from "../strategy";
import { ingestEvents } from "../cdp";
import { narrate } from "../ai/provider";
import { bucket, daysAgo, hoursAgo, id, nowIso, ORG_ID, pct, round } from "../util";
import { Actor } from "../audit";

export type RunCtx = {
  runId: string; scenario: string; mode: "manual" | "auto"; simulation: boolean; params: Record<string, unknown>;
  strategy: { strategyId: string; version: number; config: Record<string, unknown> };
  out: Record<string, Record<string, unknown>>; opportunityId: string | null;
  tool: <T>(name: string, args: unknown, fn: () => T | Promise<T>, summarize?: (r: T) => string) => Promise<T>;
};
export type AgentResult = {
  summary: string; output: Record<string, unknown>; evidence?: Array<{ label: string; value: unknown; source: string; kind?: "verified" | "estimate" | "assumption" }>;
  confidence?: number; halt?: string; awaitApproval?: boolean; tokens?: number;
};
type Handler = (ctx: RunCtx) => Promise<AgentResult>;
const AGENT_ACTOR = (k: string): Actor => ({ type: "agent", id: `agent:${k}` });

// ─────────────────────────── shared helpers ───────────────────────────
function upsertOpportunity(ctx: RunCtx, o: { key: string; title: string; description: string; category: string; severity: string; affected: number; systems: string[]; evidence: unknown[]; causes?: string[]; actions?: string[]; impact?: string; risk?: string }) {
  const existing = one<{ id: string }>("SELECT id FROM opportunities WHERE dedupe_key = ?", o.key);
  const oid = existing?.id ?? id("opp");
  if (existing) run("UPDATE opportunities SET affected_users = ?, evidence = ?, severity = ?, status = 'in_progress', run_id = ?, strategy_version = ?, updated_at = ? WHERE id = ?", o.affected, J.str(o.evidence), o.severity, ctx.runId, ctx.strategy.version, nowIso(), oid);
  else run(`INSERT INTO opportunities (id, org_id, title, description, category, detected_at, severity, evidence, affected_users, affected_systems, possible_causes, recommended_actions, estimated_impact, risk_class, status, workflow_id, run_id, strategy_id, strategy_version, dedupe_key, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, oid, ORG_ID, o.title, o.description, o.category, nowIso(), o.severity, J.str(o.evidence), o.affected, J.str(o.systems), J.str(o.causes ?? []), J.str(o.actions ?? []), o.impact ?? null, o.risk ?? "low", "in_progress",
    `wf_${ctx.scenario}`, ctx.runId, ctx.strategy.strategyId, ctx.strategy.version, o.key, nowIso());
  ctx.opportunityId = oid;
  run("UPDATE ai_workflow_runs SET opportunity_id = ? WHERE id = ?", oid, ctx.runId);
  return oid;
}

function ensureSegment(name: string, purpose: string, rules: Rule, description: string, type: "dynamic" | "static" = "dynamic") {
  const ex = one<{ id: string }>("SELECT id FROM segments WHERE name = ?", name);
  if (ex) { evaluateSegment(ex.id); return ex.id; }
  return createSegment({ name, description, type, purpose, rules, aiGenerated: true }, AGENT_ACTOR("audience")).id;
}

/** Optimizer: create candidate (unless one is already pending), evaluate with a z-test, route to approval. */
async function optimize(ctx: RunCtx, p: { config: Record<string, unknown>; summary: string; risk: "low" | "medium" | "high"; baseline: { n: number; s: number }; candidate: { n: number; s: number }; method: string }): Promise<AgentResult> {
  const strat = getStrategy(one<{ category: string }>("SELECT category FROM strategies WHERE id = ?", ctx.strategy.strategyId)!.category)!;
  const pending = one<{ version: number; status: string }>("SELECT version, status FROM strategy_versions WHERE strategy_id = ? AND status IN ('candidate','testing','pending_approval') ORDER BY version DESC LIMIT 1", strat.id);
  if (pending) return { summary: `Candidate v${pending.version} is already ${pending.status.replace("_", " ")} — not generating another`, output: { pending_version: pending.version }, confidence: 1 };
  if (ctx.simulation) return { summary: `Simulation: would propose "${p.summary}" (no candidate persisted)`, output: { proposed: p.config, baseline: p.baseline, candidate: p.candidate }, confidence: 0.6 };
  if (JSON.stringify(p.config) === JSON.stringify(ctx.strategy.config)) return { summary: "No configuration change warranted by the evidence", output: {}, confidence: 0.8 };
  const v = await ctx.tool("strategy.candidate", { summary: p.summary }, () => createCandidate({ category: strat.category, config: p.config, summary: p.summary, createdBy: "agent:optimizer", risk: p.risk }), (r) => `v${r.version} created`);
  const ev = await ctx.tool("stats.ztest", { baseline: p.baseline, candidate: p.candidate, method: p.method }, () => evaluateCandidate(strat.id, v.version, { baseline: p.baseline, candidate: p.candidate }, AGENT_ACTOR("optimizer")), (r) => `${r.verdict} (p=${r.test.pValue.toFixed(4)})`);
  let routed: unknown = null;
  if (ev.verdict === "promote") routed = await ctx.tool("approvals.create", { version: v.version }, () => submitForApproval(strat.id, v.version, "agent:optimizer"), (r) => (r.autoApproved ? "auto-approved & activated" : `approval ${r.approvalId}`));
  const t = ev.test;
  return {
    summary: ev.verdict === "promote" ? `Candidate v${v.version} improves ${strat.primary_metric} by ${round(t.diff * 100, 1)} pts (p=${t.pValue.toFixed(4)}) → ${(routed as { autoApproved?: boolean })?.autoApproved ? "auto-approved and activated" : "sent for approval"}`
      : `Candidate v${v.version}: ${ev.verdict.replace("_", " ")} (Δ ${round(t.diff * 100, 1)} pts, p=${t.pValue.toFixed(3)}) — not promoted`,
    output: { candidate_version: v.version, verdict: ev.verdict, baseline_rate: t.p1, candidate_rate: t.p2, p_value: t.pValue, ci: [t.ciLow, t.ciHigh], routed, method: p.method, change: p.summary },
    evidence: [{ label: "Method", value: p.method, source: "historical replay / experiment", kind: "verified" }, { label: "Baseline", value: p.baseline, source: "event store", kind: "verified" }, { label: "Candidate", value: p.candidate, source: "replay", kind: "estimate" }],
    confidence: ev.significant ? 0.9 : 0.5,
  };
}

/** Policy engine for the approval gateway. Deterministic; AI proposals are untrusted until validated here. */
const AUTO_ALLOWED = new Set(["create_investigation_ticket", "create_segment", "send_service_notification", "publish_service_journey", "create_protective_task", "fallback_resend", "verify_protection"]);
export function policyEvaluate(actions: Array<{ type: string; risk: string; audience?: number; purpose?: string }>, mode: string) {
  const estop = one<{ value: string }>("SELECT value FROM settings WHERE key = 'emergency_stop'")?.value === "true";
  const maxAuto = Number(J.parse<Record<string, unknown>>(one<{ value: string }>("SELECT value FROM settings WHERE key = 'policy'")?.value, {}).max_auto_audience ?? 2000);
  return actions.map((a) => {
    const reasons: string[] = [];
    if (estop) reasons.push("emergency stop active");
    if (mode !== "auto") reasons.push("manual mode — human approval required");
    if (!AUTO_ALLOWED.has(a.type)) reasons.push(`${a.type} is not on the authorized automatic action list`);
    if (a.risk !== "low") reasons.push(`risk ${a.risk}`);
    if ((a.audience ?? 0) > maxAuto) reasons.push(`audience ${a.audience} > auto limit ${maxAuto}`);
    if (a.purpose && ["marketing", "membership", "regulated_promotion"].includes(a.purpose)) reasons.push("promotional purpose");
    return { ...a, auto: reasons.length === 0, reasons };
  });
}

// ─────────────────────────── Scenario A — provider failure ───────────────────────────
type ProvStat = { provider_id: string; name: string; launches: number; failures: number; rate: number; players: number };
function providerStats(hours: number): ProvStat[] {
  return all<ProvStat>(`SELECT e.provider_id, p.name, COUNT(*) launches, SUM(CASE WHEN e.event_name = 'game_launch_failed' THEN 1 ELSE 0 END) failures,
    ROUND(1.0 * SUM(CASE WHEN e.event_name = 'game_launch_failed' THEN 1 ELSE 0 END) / COUNT(*), 4) rate,
    COUNT(DISTINCT CASE WHEN e.event_name = 'game_launch_failed' THEN e.player_id END) players
    FROM events e JOIN gaming_providers p ON p.id = e.provider_id WHERE e.event_name IN ('game_launch_success','game_launch_failed') AND e.event_time >= ? GROUP BY e.provider_id ORDER BY rate DESC`, hoursAgo(hours));
}
/** Replay: how many affected players would have been covered (detected before their first failure) at a threshold. */
function detectionCoverage(providerId: string, threshold: number, minLaunches: number, hours: number) {
  const evs = all<{ event_name: string; player_id: string; event_time: string }>("SELECT event_name, player_id, event_time FROM events WHERE provider_id = ? AND event_name IN ('game_launch_success','game_launch_failed') AND event_time >= ? ORDER BY event_time", providerId, hoursAgo(hours));
  let l = 0, f = 0, detectedAt: string | null = null;
  const firstFail = new Map<string, string>();
  for (const e of evs) {
    l++; if (e.event_name === "game_launch_failed") { f++; if (!firstFail.has(e.player_id)) firstFail.set(e.player_id, e.event_time); }
    if (!detectedAt && l >= minLaunches && f / l >= threshold) detectedAt = e.event_time;
  }
  let covered = 0;
  for (const t of firstFail.values()) if (detectedAt && t >= detectedAt) covered++;
  return { n: firstFail.size, s: covered, detectedAt };
}

const A: Record<string, Handler> = {
  async data_intel(ctx) {
    const hours = Number(ctx.strategy.config.window_hours ?? 24);
    const stats = await ctx.tool("sql.query", { query: "provider_launch_stats", window_hours: hours }, () => providerStats(hours), (r) => `${r.length} providers`);
    const totals = stats.reduce((a, s) => ({ l: a.l + s.launches, f: a.f + s.failures }), { l: 0, f: 0 });
    const fresh = one<{ t: string }>("SELECT MAX(event_time) t FROM events")?.t;
    return { summary: `${totals.l.toLocaleString()} launches across ${stats.length} providers in ${hours}h; overall failure rate ${pct(totals.f, totals.l)}%`, output: { stats: stats.slice(0, 20), totals, freshness: fresh },
      evidence: [{ label: "Launch events", value: totals.l, source: "events (game_launch_success|failed)", kind: "verified" }, { label: "Data freshness", value: fresh, source: "events.max(event_time)", kind: "verified" }], confidence: 0.95 };
  },
  async discovery(ctx) {
    const c = ctx.strategy.config as { failure_rate_threshold: number; min_launches: number; severity_high_rate: number };
    const stats = ctx.out.data_intel.stats as ProvStat[];
    const anomalies = stats.filter((s) => s.launches >= c.min_launches && s.rate >= c.failure_rate_threshold);
    if (!anomalies.length) return { summary: `No provider above ${c.failure_rate_threshold * 100}% failure threshold (strategy v${ctx.strategy.version})`, output: { anomalies: [] }, halt: "No anomaly detected" };
    const worst = ctx.params.provider_id ? anomalies.find((a) => a.provider_id === ctx.params.provider_id) ?? anomalies[0] : anomalies[0];
    const severity = worst.rate >= c.severity_high_rate ? "high" : "medium";
    await ctx.tool("opportunities.upsert", { provider: worst.provider_id }, () => upsertOpportunity(ctx, {
      key: `provider_failure:${worst.provider_id}:${nowIso().slice(0, 10)}`, title: `${worst.name} game launch failures at ${round(worst.rate * 100, 1)}%`, description: `Launch failure rate ${round(worst.rate * 100, 1)}% over ${worst.launches} launches exceeds the ${c.failure_rate_threshold * 100}% threshold.`,
      category: "gaming_provider", severity, affected: worst.players, systems: ["game-launcher", worst.provider_id], evidence: [{ launches: worst.launches, failures: worst.failures, rate: worst.rate }], risk: severity === "high" ? "medium" : "low",
      actions: ["Open provider investigation", "Notify affected players (service)", "Monitor recovery"], impact: `${worst.players} players affected`,
    }), (r) => r);
    return { summary: `Detected ${anomalies.length} anomalous provider(s); focusing on ${worst.name} (${round(worst.rate * 100, 1)}%, ${worst.players} players)`, output: { provider: worst, anomalies, severity },
      evidence: anomalies.map((a) => ({ label: a.name, value: `${round(a.rate * 100, 1)}% of ${a.launches}`, source: "providerStats", kind: "verified" as const })), confidence: 0.9 };
  },
  async gaming_intel(ctx) {
    const p = (ctx.out.discovery.provider as ProvStat).provider_id; const since = hoursAgo(Number(ctx.strategy.config.window_hours ?? 24));
    const q = (sql: string) => all(sql, p, since);
    const r = await ctx.tool("sql.query", { query: "failure_breakdown", provider: p }, () => ({
      games: q(`SELECT g.name, COUNT(*) failures FROM events e JOIN games g ON g.id = e.game_id WHERE e.provider_id = ? AND e.event_time >= ? AND e.event_name = 'game_launch_failed' GROUP BY g.name ORDER BY failures DESC LIMIT 5`),
      os: q(`SELECT operating_system k, COUNT(*) n FROM events WHERE provider_id = ? AND event_time >= ? AND event_name = 'game_launch_failed' GROUP BY k ORDER BY n DESC`),
      platform: q(`SELECT platform k, COUNT(*) n FROM events WHERE provider_id = ? AND event_time >= ? AND event_name = 'game_launch_failed' GROUP BY k ORDER BY n DESC`),
      errors: q(`SELECT error_code k, COUNT(*) n FROM events WHERE provider_id = ? AND event_time >= ? AND event_name = 'game_launch_failed' GROUP BY k ORDER BY n DESC`),
      load: q(`SELECT ROUND(AVG(loading_duration)) avg_ms, MAX(loading_duration) max_ms FROM events WHERE provider_id = ? AND event_time >= ? AND event_name IN ('game_launch_failed','game_launch_success')`)[0],
    }), () => "breakdown by game/os/platform/error");
    const topErr = (r.errors as Array<{ k: string; n: number }>)[0];
    return { summary: `Top error ${topErr?.k} (${topErr?.n}); ${(r.games as unknown[]).length} games affected; avg load ${(r.load as { avg_ms: number }).avg_ms} ms`, output: r, confidence: 0.9,
      evidence: [{ label: "Top error code", value: topErr, source: "events.error_code", kind: "verified" }] };
  },
  async customer_intel(ctx) {
    const p = (ctx.out.discovery.provider as ProvStat).provider_id; const since = hoursAgo(Number(ctx.strategy.config.window_hours ?? 24));
    const ch = (ctx.strategy.config.channel_order as string[])[0];
    const r = await ctx.tool("cdp.profile", { population: "affected_players", provider: p }, () => {
      const ids = all<{ player_id: string }>("SELECT DISTINCT player_id FROM events WHERE provider_id = ? AND event_time >= ? AND event_name = 'game_launch_failed'", p, since).map((x) => x.player_id);
      const ph = ids.map(() => "?").join(",") || "''";
      return {
        affected: ids.length,
        with_open_tickets: one<{ n: number }>(`SELECT COUNT(*) n FROM customers WHERE player_id IN (${ph}) AND open_tickets > 0`, ...ids)!.n,
        tiers: all(`SELECT vip_tier k, COUNT(*) n FROM customers WHERE player_id IN (${ph}) GROUP BY k`, ...ids),
        consent_coverage: one<{ n: number }>(`SELECT COUNT(*) n FROM consent_current WHERE channel = (SELECT consent_channel FROM channels WHERE key = ?) AND purpose = 'service' AND granted = 1 AND player_id IN (${ph})`, ch, ...ids)!.n,
      };
    }, (x) => `${x.affected} affected players`);
    return { summary: `${r.affected} affected players; ${r.with_open_tickets} already have open tickets; ${pct(r.consent_coverage, r.affected)}% reachable on ${ch}`, output: { ...r, channel: ch }, confidence: 0.9,
      evidence: [{ label: "Affected players", value: r.affected, source: "events", kind: "verified" }, { label: `${ch} service consent`, value: r.consent_coverage, source: "consent_current", kind: "verified" }] };
  },
  async root_cause(ctx) {
    const g = ctx.out.gaming_intel as { errors: Array<{ k: string; n: number }>; os: Array<{ k: string; n: number }>; load: { avg_ms: number } };
    const totalErr = g.errors.reduce((s, e) => s + e.n, 0) || 1; const totalOs = g.os.reduce((s, e) => s + e.n, 0) || 1;
    const hyps = [
      { hypothesis: "Provider-side latency / timeout", score: (g.errors.find((e) => /TIMEOUT/.test(e.k))?.n ?? 0) / totalErr },
      { hypothesis: `Client compatibility on ${g.os[0]?.k}`, score: g.os[0] ? (g.os[0].n / totalOs > 0.7 ? g.os[0].n / totalOs : 0.2) : 0 },
      { hypothesis: "Provider authentication / session token errors", score: (g.errors.find((e) => /AUTH|TOKEN/.test(e.k))?.n ?? 0) / totalErr },
    ].sort((a, b) => b.score - a.score);
    const fallback = `Most likely: ${hyps[0].hypothesis} (${round(hyps[0].score * 100)}% of failures). Failures are spread across ${g.os.length} OS types, avg load ${g.load.avg_ms} ms. This is an evidence-ranked hypothesis, not a confirmed cause — provider confirmation required.`;
    const n = await ctx.tool("llm.narrate", { evidence: "hypotheses" }, () => narrate(fallback, "Explain the most likely root cause of these game launch failures in 3 sentences.", { hyps, g }), (x) => `via ${x.provider}`);
    return { summary: `Top hypothesis: ${hyps[0].hypothesis} (${round(hyps[0].score * 100)}%)`, output: { hypotheses: hyps, explanation: n.text }, tokens: n.tokens, confidence: round(Math.min(0.95, 0.4 + hyps[0].score / 2), 2),
      evidence: hyps.map((h) => ({ label: h.hypothesis, value: `${round(h.score * 100)}%`, source: "error-code/os distribution", kind: "estimate" as const })) };
  },
  async decision(ctx) {
    const affected = Number(ctx.out.customer_intel.affected);
    const actions = [
      { type: "create_investigation_ticket", risk: "low", description: `Open P1 investigation with ${(ctx.out.discovery.provider as ProvStat).name}` },
      { type: "create_segment", risk: "low", description: "Dynamic segment of affected players" },
      ...(ctx.strategy.config.notify_affected ? [{ type: "send_service_notification", risk: affected > 1500 ? "medium" : "low", purpose: "service", audience: affected, description: `Service notice via ${ctx.out.customer_intel.channel}` }] : []),
    ];
    return { summary: `${actions.length} candidate actions proposed (no compensation in strategy v${ctx.strategy.version})`, output: { actions }, confidence: 0.85 };
  },
  async audience(ctx) {
    const p = ctx.out.discovery.provider as ProvStat;
    const rule: Rule = { type: "group", op: "and", children: [{ type: "event", event: "game_launch_failed", op: "gte", count: 1, within_days: 1, provider_id: p.provider_id }] };
    const sid = await ctx.tool("segments.create", { rule }, () => ctx.simulation ? null : ensureSegment(`Affected: ${p.name} launch failures`, "service", rule, "Players with ≥1 failed launch on this provider in the last 24h"), (x) => x ?? "simulated");
    const est = estimate(rule);
    return { summary: `Segment ${sid ? "ready" : "(simulated)"}: ${est.count} players`, output: { segment_id: sid, size: est.count, rule, ...(sid ? {} : { player_ids: matchIds(rule).slice(0, 5000) }) }, confidence: 0.95 };
  },
  async campaign(ctx) {
    const ch = String(ctx.out.customer_intel.channel);
    const tpl = one<{ id: string; name: string; body: string }>("SELECT id, name, body FROM message_templates WHERE channel = ? AND purpose = 'service' AND status = 'approved' AND name LIKE '%Provider incident%' ORDER BY version DESC LIMIT 1", ch);
    return { summary: tpl ? `Draft service notice on ${ch} using approved template "${tpl.name}"` : `No approved incident template on ${ch}`, output: { channel: ch, template_id: tpl?.id, preview: tpl?.body }, confidence: tpl ? 0.9 : 0.3 };
  },
  async compliance(ctx) { return complianceNode(ctx, "service"); },
  async execution(ctx) {
    const res: Record<string, unknown> = {};
    const p = ctx.out.discovery.provider as ProvStat;
    if (!ctx.simulation) run("INSERT OR IGNORE INTO service_tickets (id, player_id, category, subject, status, priority, source, related_run_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)", `tkt_inv_${ctx.runId}`, "INTERNAL", "provider_investigation", `Investigate ${p.name} launch failures (${round(p.rate * 100, 1)}%)`, "open", "high", "ai_workflow", ctx.runId, nowIso());
    res.ticket = ctx.simulation ? "simulated" : `tkt_inv_${ctx.runId}`;
    const c = ctx.out.campaign as { channel: string; template_id?: string };
    if (c.template_id && ctx.out.audience.segment_id !== undefined) {
      const ids = audienceIds(ctx);
      res.messages = await ctx.tool("messages.send", { channel: c.channel, audience: ids.length, simulated: true }, () => sendMessages({ playerIds: ids, channel: c.channel, purpose: "service", templateId: c.template_id, idempotencyPrefix: `run:${ctx.runId}`, runId: ctx.runId, actor: AGENT_ACTOR("execution"), context: "workflow", simulateOnly: ctx.simulation }), (r) => `sent ${r.sent}, blocked ${r.blocked}, dup ${r.duplicates}`);
    }
    const m = res.messages as { sent: number; blocked: number } | undefined;
    return { summary: `Investigation ticket opened; ${m?.sent ?? 0} service notices sent (mock), ${m?.blocked ?? 0} blocked by compliance`, output: res, confidence: 1 };
  },
  async analytics(ctx) {
    const p = (ctx.out.discovery.provider as ProvStat).provider_id;
    const m = one<{ n: number; delivered: number; read: number }>("SELECT COUNT(*) n, SUM(CASE WHEN status IN ('delivered','read','clicked') THEN 1 ELSE 0 END) delivered, SUM(CASE WHEN status IN ('read','clicked') THEN 1 ELSE 0 END) read FROM messages WHERE run_id = ?", ctx.runId)!;
    const cov = detectionCoverage(p, Number(ctx.strategy.config.failure_rate_threshold), Number(ctx.strategy.config.min_launches), Number(ctx.strategy.config.window_hours ?? 24));
    const metrics = { messages: m.n, delivery_rate: m.n ? m.delivered / m.n : null, read_rate: m.n ? m.read / m.n : null, detection_coverage: cov.n ? cov.s / cov.n : 0, affected: cov.n, detected_at: cov.detectedAt };
    if (!ctx.simulation) recordExecutionResult(ctx.strategy.strategyId, ctx.strategy.version, ctx.runId, metrics);
    return { summary: `Delivery ${m.n ? pct(m.delivered, m.n) : "–"}%; detection covered ${pct(cov.s, cov.n)}% of affected players before their first failure`, output: metrics, confidence: 0.85,
      evidence: [{ label: "Detection coverage", value: `${cov.s}/${cov.n}`, source: "replay of launch events", kind: "verified" }, { label: "Delivery", value: "mock provider receipts", source: "delivery_events", kind: "estimate" }] };
  },
  async optimizer(ctx) {
    const c = ctx.strategy.config as { failure_rate_threshold: number; min_launches: number; window_hours: number };
    const p = (ctx.out.discovery.provider as ProvStat).provider_id;
    const candThr = round(Math.max(0.05, c.failure_rate_threshold - 0.03), 2);
    const base = detectionCoverage(p, c.failure_rate_threshold, c.min_launches, c.window_hours);
    const cand = detectionCoverage(p, candThr, c.min_launches, c.window_hours);
    const falseAlerts = providerStats(c.window_hours).filter((s) => s.provider_id !== p && s.launches >= c.min_launches && s.rate >= candThr).length;
    return optimize(ctx, { config: { ...c, failure_rate_threshold: candThr }, summary: `Lower failure threshold ${c.failure_rate_threshold} → ${candThr} for earlier detection (${falseAlerts} extra provider alert(s) in replay)`, risk: falseAlerts > 1 ? "medium" : "low", baseline: { n: base.n, s: base.s }, candidate: { n: cand.n, s: cand.s }, method: "Historical replay of launch events: share of affected players detected before their first failure" });
  },
};

function audienceIds(ctx: RunCtx): string[] {
  const segId = ctx.out.audience?.segment_id as string | undefined;
  if (segId) return all<{ player_id: string }>("SELECT player_id FROM segment_memberships WHERE segment_id = ?", segId).map((r) => r.player_id);
  return (ctx.out.audience?.player_ids as string[] | undefined) ?? [];
}

// shared compliance node
async function complianceNode(ctx: RunCtx, purpose: Purpose): Promise<AgentResult> {
  const ids = audienceIds(ctx);
  const ch = (ctx.out.campaign?.channel as string | undefined) ?? undefined;
  const checks = await ctx.tool("compliance.evaluate", { purpose, channel: ch, audience: ids.length }, () => evaluate({ playerIds: ids, purpose, channel: ch, action: ch ? "message" : "targeting", context: "workflow", refId: ctx.runId }), (r) => `${r.filter((x) => x.allowed).length}/${r.length} allowed`);
  const preview = String(ctx.out.campaign?.preview ?? "");
  const content = preview ? validateContent(preview, purpose) : [];
  const allowed = checks.filter((c) => c.allowed).length;
  return { summary: `${allowed}/${checks.length} players pass mandatory policies${content.length ? `; ${content.length} content issue(s)` : ""}`, output: { allowed, blocked: checks.length - allowed, by_policy: summarize(checks), content_issues: content, passed: content.length === 0 }, confidence: 1,
    evidence: Object.entries(summarize(checks)).map(([k, v]) => ({ label: `Blocked: ${k}`, value: v, source: "compliance engine", kind: "verified" as const })) };
}

// ─────────────────────────── Scenario B — KYC ───────────────────────────
const B: Record<string, Handler> = {
  async data_intel(ctx) {
    const funnel = await ctx.tool("sql.query", { query: "kyc_funnel" }, () => all<{ k: string; n: number }>("SELECT kyc_status k, COUNT(*) n FROM customers GROUP BY k ORDER BY n DESC"), (r) => `${r.length} statuses`);
    const reasons = all<{ k: string; n: number }>("SELECT kyc_failure_reason k, COUNT(*) n FROM customers WHERE kyc_status = 'failed' GROUP BY k ORDER BY n DESC");
    const stalled = one<{ n: number }>("SELECT COUNT(*) n FROM customers WHERE kyc_status IN ('pending','failed') AND kyc_updated_at < ?", hoursAgo(Number(ctx.strategy.config.stalled_after_hours ?? 24)))!.n;
    return { summary: `KYC funnel: ${funnel.map((f) => `${f.k} ${f.n}`).join(", ")}; ${stalled} stalled > ${ctx.strategy.config.stalled_after_hours}h`, output: { funnel, reasons, stalled }, confidence: 0.95,
      evidence: [{ label: "Stalled players", value: stalled, source: "customers.kyc_status/kyc_updated_at", kind: "verified" }] };
  },
  async discovery(ctx) {
    const stalled = Number(ctx.out.data_intel.stalled);
    if (stalled < 20) return { summary: "No material KYC breakpoint", output: {}, halt: "Stalled volume below threshold" };
    const top = (ctx.out.data_intel.reasons as Array<{ k: string; n: number }>)[0];
    await ctx.tool("opportunities.upsert", {}, () => upsertOpportunity(ctx, { key: `kyc_breakpoint:${nowIso().slice(0, 10)}`, title: `KYC breakpoint: ${stalled} players stalled (top failure: ${top?.k})`, description: "Players started KYC but have not completed it.", category: "kyc", severity: stalled > 500 ? "high" : "medium", affected: stalled, systems: ["kyc-service"], evidence: [ctx.out.data_intel], actions: ["Service guidance journey", "Exit when verified"] }), (x) => x);
    return { summary: `Breakpoint: ${stalled} stalled; top failure reason ${top?.k}`, output: { stalled, top_reason: top }, confidence: 0.9 };
  },
  async customer_intel(ctx) {
    const r = all<{ k: string; n: number }>("SELECT primary_platform k, COUNT(*) n FROM customers WHERE kyc_status IN ('pending','failed') GROUP BY k");
    const consent = all<{ channel: string; n: number }>("SELECT c.channel, COUNT(*) n FROM consent_current c JOIN customers u ON u.player_id = c.player_id WHERE u.kyc_status IN ('pending','failed') AND c.purpose = 'service' AND c.granted = 1 GROUP BY c.channel");
    return { summary: `Stalled by platform: ${r.map((x) => `${x.k} ${x.n}`).join(", ")}`, output: { platforms: r, consent }, confidence: 0.9 };
  },
  async root_cause(ctx) {
    const top = ctx.out.discovery.top_reason as { k: string; n: number } | undefined;
    const plat = (ctx.out.customer_intel.platforms as Array<{ k: string; n: number }>).sort((a, b) => b.n - a.n)[0];
    const n = await ctx.tool("llm.narrate", {}, () => narrate(`Primary driver: ${top?.k ?? "unknown"} document failures; ${plat?.k} users are the largest stalled group. Clear guidance on document capture is the most likely fix (hypothesis).`, "Summarize the KYC breakpoint cause in 2 sentences.", { top, plat }), (x) => x.provider);
    return { summary: `Likely driver: ${top?.k} on ${plat?.k}`, output: { explanation: n.text }, confidence: 0.7, tokens: n.tokens };
  },
  async decision(ctx) {
    return { summary: "Proposed: dynamic 'KYC stalled' segment + service guidance journey (exits on verification)", output: { actions: [
      { type: "create_segment", risk: "low", description: "KYC stalled (dynamic, exits on verification)" },
      { type: "publish_service_journey", risk: "low", purpose: "service", audience: Number(ctx.out.discovery.stalled), description: `Reminder every ${ctx.strategy.config.reminder_wait_hours}h, max ${ctx.strategy.config.max_reminders}` }] }, confidence: 0.85 };
  },
  async audience(ctx) {
    const rule: Rule = { type: "group", op: "and", children: [{ type: "attr", field: "kyc_status", op: "in", value: ["pending", "failed"] }, { type: "attr", field: "kyc_updated_at", op: "older_than_days", value: Number(ctx.strategy.config.stalled_after_hours ?? 24) / 24 }, { type: "attr", field: "account_status", op: "eq", value: "active" }] };
    const sid = ctx.simulation ? one<{ id: string }>("SELECT id FROM segments WHERE name = 'KYC stalled'")?.id ?? null : await ctx.tool("segments.create", { rule }, () => ensureSegment("KYC stalled", "service", rule, "Players with pending/failed KYC not updated recently"), (x) => x);
    return { summary: `Segment "KYC stalled": ${estimate(rule).count} players`, output: { segment_id: sid, rule }, confidence: 0.95 };
  },
  async journey(ctx) {
    const j = one<{ id: string; published_version: number | null }>("SELECT id, published_version FROM journeys WHERE name = 'KYC Assistance'");
    if (!j) return { summary: "KYC journey template missing", output: {}, halt: "Journey missing" };
    const def = J.parse<JourneyDef>(getJourney(j.id).draft_definition, { nodes: [], edges: [] });
    const segId = ctx.out.audience.segment_id;
    for (const n of def.nodes) if (n.kind === "segment_entry") n.data.segment_id = segId;
    if (!ctx.simulation) run("UPDATE journeys SET draft_definition = ? WHERE id = ?", J.str(def), j.id);
    const sim = await ctx.tool("journeys.plan", { journey: j.id }, () => simulateJourney(def, "service", 300), (r) => `${r.sample} simulated`);
    return { summary: `Journey "KYC Assistance" planned with wait = strategy.reminder_wait_hours (${ctx.strategy.config.reminder_wait_hours}h)`, output: { journey_id: j.id, simulation: sim.counts, issues: sim.issues }, confidence: 0.9 };
  },
  async compliance(ctx) {
    const ids = all<{ player_id: string }>("SELECT player_id FROM segment_memberships WHERE segment_id = ?", ctx.out.audience.segment_id ?? "").map((r) => r.player_id);
    const sms = evaluate({ playerIds: ids, purpose: "service", channel: "sms", action: "message", context: "workflow", refId: ctx.runId });
    return { summary: `${sms.filter((c) => c.allowed).length}/${ids.length} reachable by SMS (service consent)`, output: { by_policy: summarize(sms), passed: true }, confidence: 1 };
  },
  async execution(ctx) {
    const jid = String(ctx.out.journey.journey_id);
    if (ctx.simulation) return { summary: "Simulation — journey not published", output: { simulated: true } };
    const j = getJourney(jid);
    let pub: unknown = { version: j.published_version, status: "already_published" };
    const pinned = one<{ strategy_version: number }>("SELECT strategy_version FROM journey_versions WHERE journey_id = ? AND version = ?", jid, j.published_version ?? 0)?.strategy_version;
    if (!j.published_version || pinned !== ctx.strategy.version) pub = await ctx.tool("journeys.publish", { jid }, () => publishJourney(jid, AGENT_ACTOR("execution")), (r) => `v${r.version}`);
    run("UPDATE journeys SET status = 'active' WHERE id = ?", jid);
    const ids = all<{ player_id: string }>("SELECT player_id FROM segment_memberships WHERE segment_id = ?", ctx.out.audience.segment_id).map((r) => r.player_id);
    const en = await ctx.tool("journeys.enroll", { count: ids.length }, () => enroll(jid, ids, `workflow:${ctx.runId}`), (r) => `${r.enrolled} enrolled, ${r.duplicates} already active`);
    return { summary: `Journey live; ${en.enrolled} enrolled (${en.duplicates} already in journey — no duplicate reminders)`, output: { publish: pub, ...en }, confidence: 1 };
  },
  async analytics(ctx) {
    const jid = String(ctx.out.journey.journey_id);
    const r = one<{ n: number; done: number }>("SELECT COUNT(*) n, SUM(CASE WHEN exit_reason IN ('left_trigger_segment','kyc_completed') THEN 1 ELSE 0 END) done FROM journey_executions WHERE journey_id = ?", jid)!;
    const metrics = { executions: r.n, completed_kyc: r.done, completion_rate: r.n ? r.done / r.n : 0 };
    if (!ctx.simulation) recordExecutionResult(ctx.strategy.strategyId, ctx.strategy.version, ctx.runId, metrics);
    return { summary: `KYC completion among journey participants: ${pct(r.done, r.n)}% (${r.done}/${r.n})`, output: metrics, confidence: 0.8 };
  },
  async optimizer(ctx) {
    const c = ctx.strategy.config as { reminder_wait_hours: number };
    const cand = c.reminder_wait_hours > 24 ? 24 : 12;
    const cohort = (h: number) => one<{ n: number; s: number }>("SELECT COUNT(*) n, SUM(CASE WHEN exit_reason = 'kyc_completed' THEN 1 ELSE 0 END) s FROM journey_executions WHERE journey_id = (SELECT id FROM journeys WHERE name = 'KYC Assistance') AND json_extract(history, '$[0].wait_hours') = ?", h)!;
    const b = cohort(c.reminder_wait_hours), k = cohort(cand);
    return optimize(ctx, { config: { ...c, reminder_wait_hours: cand }, summary: `Shorten reminder wait ${c.reminder_wait_hours}h → ${cand}h`, risk: "low", baseline: { n: b.n, s: b.s ?? 0 }, candidate: { n: k.n, s: k.s ?? 0 }, method: "Controlled holdout: historical journey cohorts by reminder interval" });
  },
};

// ─────────────────────────── Scenario C — membership entitlements ───────────────────────────
const C: Record<string, Handler> = {
  async data_intel(ctx) {
    const offerId = String(ctx.params.offer_id ?? "off_member_monthly");
    const o = one<{ name: string; base_amount: number }>("SELECT name, base_amount FROM offers WHERE id = ?", offerId);
    const b = one<{ total: number; reserved: number; spent: number }>("SELECT total, reserved, spent FROM offer_budgets WHERE offer_id = ?", offerId);
    const dups = one<{ n: number }>("SELECT COUNT(*) n FROM duplicate_prevention_log WHERE kind = 'offer'")!.n;
    return { summary: `${o?.name}: base ${o?.base_amount}; budget ${b ? round(((b.reserved + b.spent) / b.total) * 100, 1) : 0}% used; ${dups} duplicate issuances prevented to date`, output: { offer_id: offerId, offer: o, budget: b, duplicates_prevented: dups }, confidence: 0.95 };
  },
  async discovery(ctx) {
    upsertOpportunity(ctx, { key: `membership_cycle:${nowIso().slice(0, 7)}`, title: "Monthly membership benefit cycle due", description: "Scheduled membership entitlement evaluation for verified active members.", category: "entitlement", severity: "low", affected: 0, systems: ["offers"], evidence: [ctx.out.data_intel.budget] });
    return { summary: "Monthly membership cycle is due", output: {}, confidence: 1 };
  },
  async customer_intel() {
    const tiers = all<{ k: string; n: number }>("SELECT vip_tier k, COUNT(*) n FROM customers WHERE kyc_status = 'verified' AND last_active_at >= ? GROUP BY k", daysAgo(30));
    return { summary: `Verified active members by tier: ${tiers.map((t) => `${t.k} ${t.n}`).join(", ")}`, output: { tiers }, confidence: 0.95 };
  },
  async decision() {
    return { summary: "Proposed: evaluate & issue monthly membership benefit (deterministic tiers, approval required)", output: { actions: [{ type: "issue_entitlement", risk: "medium", purpose: "membership", description: "Monthly membership benefit" }] }, confidence: 0.9 };
  },
  async audience(ctx) {
    const rule: Rule = { type: "group", op: "and", children: [{ type: "attr", field: "kyc_status", op: "eq", value: "verified" }, { type: "attr", field: "last_active_at", op: "within_last_days", value: 30 }] };
    const sid = ctx.simulation ? one<{ id: string }>("SELECT id FROM segments WHERE name = 'Verified active members'")?.id ?? null : await ctx.tool("segments.create", { rule }, () => ensureSegment("Verified active members", "membership", rule, "KYC-verified members active in 30 days (promotional exclusions applied)"), (x) => x);
    return { summary: `Audience: ${estimate(rule, "membership").count} eligible-by-policy members (exclusions applied)`, output: { segment_id: sid, rule }, confidence: 0.95 };
  },
  async offer_eligibility(ctx) {
    const ids = all<{ player_id: string }>("SELECT player_id FROM segment_memberships WHERE segment_id = ? ORDER BY player_id LIMIT 3000", ctx.out.audience.segment_id ?? "").map((r) => r.player_id);
    const { decisions } = await ctx.tool("offers.simulate", { offer: ctx.out.data_intel.offer_id, audience: ids.length }, () => decideForPlayers(String(ctx.out.data_intel.offer_id), ids), (r) => `${r.decisions.length} decisions`);
    const s = summarizeDecisions(decisions);
    return { summary: `No ${s.distribution.none} · Reduced ${s.distribution.reduced} · Standard ${s.distribution.standard} · Enhanced ${s.distribution.enhanced}; total ${s.total_amount}`, output: { player_ids: ids, summary: s, sample: decisions.slice(0, 8) }, confidence: 1,
      evidence: [{ label: "Decision inputs", value: "tier, tenure, KYC, budget, existing entitlements, compliance", source: "offer engine", kind: "verified" }, { label: "Excluded inputs", value: "deposits, losses, wagering, vulnerability", source: "policy", kind: "verified" }] };
  },
  async compliance(ctx) {
    const s = ctx.out.offer_eligibility.summary as { none_reasons: Record<string, number> };
    return { summary: `Compliance & eligibility exclusions applied: ${JSON.stringify(s.none_reasons)}`, output: { none_reasons: s.none_reasons, passed: true }, confidence: 1 };
  },
  async execution(ctx) {
    const ids = ctx.out.offer_eligibility.player_ids as string[];
    const r = await ctx.tool("offers.issue", { audience: ids.length, simulate: ctx.simulation }, () => {
      const b = runBatch(String(ctx.out.data_intel.offer_id), ids, { simulate: ctx.simulation, actor: AGENT_ACTOR("execution"), preApproved: true });
      return { batch: b.batchId, issued: b.issued, summary: b.summary };
    }, (x) => `${x.issued?.issued ?? 0} issued, ${x.issued?.duplicates ?? 0} duplicates prevented`);
    if (!ctx.simulation) {
      // simulated claim/redemption tracking (mock wallet)
      const txs = all<{ id: string }>("SELECT t.id FROM offer_transactions t JOIN offer_decisions d ON d.id = t.decision_id WHERE d.batch_id = ?", r.batch);
      for (const t of txs) { if (bucket(`claim:${t.id}`) < 0.6) { transition(t.id, "claimed", AGENT_ACTOR("execution")); if (bucket(`redeem:${t.id}`) < 0.5) transition(t.id, "redeemed", AGENT_ACTOR("execution")); } }
    }
    return { summary: ctx.simulation ? "Simulation — nothing issued" : `Issued ${r.issued?.issued ?? 0} entitlements (mock wallet); ${r.issued?.duplicates ?? 0} duplicates prevented; claims simulated`, output: r, confidence: 1 };
  },
  async analytics(ctx) {
    const batch = (ctx.out.execution as { batch?: string }).batch;
    const st = all<{ status: string; n: number; amt: number }>("SELECT t.status, COUNT(*) n, SUM(t.amount) amt FROM offer_transactions t JOIN offer_decisions d ON d.id = t.decision_id WHERE d.batch_id = ? GROUP BY t.status", batch ?? "");
    const fairness = all("SELECT c.vip_tier, d.outcome, COUNT(*) n FROM offer_decisions d JOIN customers c ON c.player_id = d.player_id WHERE d.batch_id = ? GROUP BY c.vip_tier, d.outcome", batch ?? "");
    const s = ctx.out.offer_eligibility.summary as { eligible: number; distribution: Record<string, number> };
    const metrics = { statuses: st, fairness, consistency_rate: s.eligible ? 1 - (s.distribution.reduced ?? 0) / Math.max(1, s.eligible) : 0 };
    if (!ctx.simulation) recordExecutionResult(ctx.strategy.strategyId, ctx.strategy.version, ctx.runId, metrics);
    return { summary: `Lifecycle: ${st.map((x) => `${x.status} ${x.n}`).join(", ") || "n/a"}`, output: metrics, confidence: 0.9 };
  },
  async optimizer(ctx) {
    const c = ctx.strategy.config as { tiers: Record<string, number> };
    const ids = ctx.out.offer_eligibility.player_ids as string[];
    const cand = { ...c, tiers: { ...c.tiers, enhanced: round(Math.max(1.1, c.tiers.enhanced - 0.2), 2) } };
    const served = (cfg: Record<string, unknown>) => { const d = decideForPlayers(String(ctx.out.data_intel.offer_id), ids, { config: cfg }).decisions.filter((x) => x.outcome !== "none" || x.rules.includes("budget.exhausted")); return { n: d.length, s: d.filter((x) => !x.rules.some((r) => r.startsWith("budget."))).length }; };
    const b = served({}), k = served({ tiers: cand.tiers });
    return optimize(ctx, { config: cand, summary: `Enhanced tier ${c.tiers.enhanced}× → ${cand.tiers.enhanced}× so more eligible members are served at their intended tier within budget`, risk: "medium", baseline: b, candidate: k, method: "Deterministic replay of the decision engine on the same audience and budget" });
  },
};

// ─────────────────────────── Scenario D — channel delivery ───────────────────────────
const chanRate = (ch: string, hours: number) => one<{ n: number; s: number; cost: number }>("SELECT COUNT(*) n, SUM(CASE WHEN status IN ('delivered','read','clicked') THEN 1 ELSE 0 END) s, ROUND(AVG(cost),3) cost FROM messages WHERE channel = ? AND created_at >= ?", ch, hoursAgo(hours))!;
const D: Record<string, Handler> = {
  async data_intel(ctx) {
    const h = Number(ctx.strategy.config.evaluation_window_hours ?? 24);
    const rows = await ctx.tool("sql.query", { query: "channel_delivery", hours: h }, () => all<{ channel: string; n: number; s: number }>("SELECT channel, COUNT(*) n, SUM(CASE WHEN status IN ('delivered','read','clicked') THEN 1 ELSE 0 END) s FROM messages WHERE created_at >= ? GROUP BY channel", hoursAgo(h)), (r) => `${r.length} channels`);
    return { summary: rows.map((r) => `${r.channel} ${pct(r.s, r.n)}%`).join(" · "), output: { rows, window: h }, confidence: 0.95 };
  },
  async discovery(ctx) {
    const primary = String(ctx.strategy.config.primary);
    const r = (ctx.out.data_intel.rows as Array<{ channel: string; n: number; s: number }>).find((x) => x.channel === primary);
    const rate = r && r.n ? r.s / r.n : 1;
    if (rate >= Number(ctx.strategy.config.min_delivery_rate)) return { summary: `${primary} delivery ${round(rate * 100, 1)}% is within target`, output: {}, halt: "Delivery healthy" };
    upsertOpportunity(ctx, { key: `delivery:${primary}:${nowIso().slice(0, 10)}`, title: `${primary.toUpperCase()} delivery reliability dropped to ${round(rate * 100, 1)}%`, description: `Below the ${Number(ctx.strategy.config.min_delivery_rate) * 100}% target.`, category: "channel_delivery", severity: rate < 0.75 ? "high" : "medium", affected: r!.n - r!.s, systems: [primary], evidence: [r] });
    return { summary: `${primary} delivery ${round(rate * 100, 1)}% < target`, output: { channel: primary, rate, failed: r!.n - r!.s }, confidence: 0.95 };
  },
  async customer_intel(ctx) {
    const ch = String(ctx.out.discovery.channel);
    const failed = all<{ player_id: string }>("SELECT DISTINCT player_id FROM messages WHERE channel = ? AND status = 'failed' AND purpose IN ('service','security','operational') AND created_at >= ?", ch, hoursAgo(Number(ctx.out.data_intel.window))).map((r) => r.player_id);
    const ph = failed.map(() => "?").join(",") || "''";
    const cov = all<{ channel: string; n: number }>(`SELECT channel, COUNT(*) n FROM consent_current WHERE purpose = 'service' AND granted = 1 AND player_id IN (${ph}) GROUP BY channel`, ...failed);
    return { summary: `${failed.length} players missed service messages; fallback consent: ${cov.map((c) => `${c.channel} ${c.n}`).join(", ")}`, output: { failed_players: failed, consent: cov }, confidence: 0.9 };
  },
  async root_cause(ctx) {
    const errs = all<{ k: string; n: number }>("SELECT error_code k, COUNT(*) n FROM messages WHERE channel = ? AND status = 'failed' AND created_at >= ? GROUP BY k ORDER BY n DESC", ctx.out.discovery.channel, hoursAgo(24));
    return { summary: `Top provider error: ${errs[0]?.k} (${errs[0]?.n})`, output: { errors: errs }, confidence: 0.75, evidence: errs.map((e) => ({ label: e.k, value: e.n, source: "messages.error_code", kind: "verified" as const })) };
  },
  async decision(ctx) {
    const n = (ctx.out.customer_intel.failed_players as string[]).length;
    return { summary: "Proposed: resend failed service messages through consented fallback channels", output: { actions: [{ type: "create_segment", risk: "low", description: "Players with failed service SMS (24h)" }, { type: "fallback_resend", risk: n > 1500 ? "medium" : "low", purpose: "service", audience: n, description: `Fallback via ${(ctx.strategy.config.fallbacks as string[]).join(" → ")}` }] }, confidence: 0.85 };
  },
  async audience(ctx) {
    const ids = ctx.out.customer_intel.failed_players as string[];
    let sid: string | null = null;
    if (!ctx.simulation) {
      sid = id("seg");
      run("INSERT INTO segments (id, org_id, name, description, segment_type, purpose, rules, member_count, created_by, created_at, updated_at, last_evaluated_at, ai_generated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)", sid, ORG_ID, `Failed ${ctx.out.discovery.channel} service messages ${nowIso().slice(0, 16)}`, "Static snapshot for fallback resend", "static", "service", J.str({ type: "group", op: "and", children: [] }), ids.length, "agent:audience", nowIso(), nowIso(), nowIso());
      const ins = "INSERT OR IGNORE INTO segment_memberships (segment_id, player_id, joined_at) VALUES (?,?,?)";
      for (const p of ids) run(ins, sid, p, nowIso());
    }
    return { summary: `Static recovery segment: ${ids.length} players`, output: { segment_id: sid, size: ids.length }, confidence: 1 };
  },
  async campaign(ctx) {
    const fb = ctx.strategy.config.fallbacks as string[];
    const tpl = one<{ id: string; body: string; channel: string }>(`SELECT id, body, channel FROM message_templates WHERE purpose = 'service' AND status = 'approved' AND channel = ? AND name LIKE '%Account notice%' LIMIT 1`, fb[0]);
    return { summary: `Recovery plan: ${fb.join(" → ")} using approved template`, output: { channel: fb[0], fallbacks: fb, template_id: tpl?.id, preview: tpl?.body }, confidence: tpl ? 0.9 : 0.3 };
  },
  async compliance(ctx) { return complianceNode(ctx, "service"); },
  async execution(ctx) {
    const fb = ctx.out.campaign.fallbacks as string[];
    let remaining = ctx.out.customer_intel.failed_players as string[];
    const results: Record<string, unknown> = {};
    for (const ch of fb) {
      const tpl = one<{ id: string }>("SELECT id FROM message_templates WHERE purpose = 'service' AND status = 'approved' AND channel = ? AND name LIKE '%Account notice%' LIMIT 1", ch);
      if (!tpl || !remaining.length) continue;
      const r = await ctx.tool("messages.send", { channel: ch, audience: remaining.length }, () => sendMessages({ playerIds: remaining, channel: ch, purpose: "service", templateId: tpl.id, idempotencyPrefix: `run:${ctx.runId}`, runId: ctx.runId, actor: AGENT_ACTOR("execution"), context: "workflow", simulateOnly: ctx.simulation }), (x) => `sent ${x.sent}, blocked ${x.blocked}`);
      results[ch] = { sent: r.sent, blocked: r.blocked, cost: round(r.cost) };
      const blocked = new Set(evaluate({ playerIds: remaining, purpose: "service", channel: ch, action: "message", log: false }).filter((x) => !x.allowed).map((x) => x.player_id));
      remaining = remaining.filter((p) => blocked.has(p));
    }
    return { summary: `Fallback delivery: ${Object.entries(results).map(([k, v]) => `${k} ${(v as { sent: number }).sent}`).join(", ")}; ${remaining.length} unreachable (no consent)`, output: { results, unreachable: remaining.length }, confidence: 1 };
  },
  async analytics(ctx) {
    const primary = String(ctx.out.discovery.channel);
    const p = chanRate(primary, 24);
    const fb = (ctx.out.campaign.fallbacks as string[]).map((ch) => ({ ch, ...chanRate(ch, 24) }));
    const metrics = { primary: { ch: primary, rate: p.n ? p.s / p.n : 0, cost: p.cost }, fallbacks: fb.map((f) => ({ ch: f.ch, rate: f.n ? f.s / f.n : 0, cost: f.cost, n: f.n })) };
    if (!ctx.simulation) recordExecutionResult(ctx.strategy.strategyId, ctx.strategy.version, ctx.runId, metrics);
    return { summary: `${primary}: ${round(metrics.primary.rate * 100, 1)}% @ ${p.cost}/msg · ${metrics.fallbacks.map((f) => `${f.ch}: ${round(f.rate * 100, 1)}% @ ${f.cost}`).join(" · ")}`, output: metrics, confidence: 0.85 };
  },
  async optimizer(ctx) {
    const c = ctx.strategy.config as { primary: string; fallbacks: string[]; max_cost_per_message: number };
    const alt = ["viber", "whatsapp", "inbox", "app_push"].filter((x) => x !== c.primary).map((ch) => ({ ch, ...chanRate(ch, 24 * 7), cost: one<{ c: number }>("SELECT cost_per_message c FROM channels WHERE key = ?", ch)!.c })).filter((x) => x.n > 50 && x.cost <= c.max_cost_per_message).sort((a, b) => b.s / b.n - a.s / a.n)[0];
    if (!alt) return { summary: "No consented alternative channel within cost limit", output: {} };
    const b = chanRate(c.primary, 24);
    return optimize(ctx, { config: { ...c, primary: c.primary, fallbacks: [alt.ch, ...c.fallbacks.filter((f) => f !== alt.ch)] }, summary: `Route service notices to ${alt.ch} first when ${c.primary} is degraded (cost ${alt.cost} ≤ ${c.max_cost_per_message})`, risk: "low", baseline: { n: b.n, s: b.s }, candidate: { n: alt.n, s: alt.s }, method: "Observed delivery receipts, 24h primary vs 7d candidate channel" });
  },
};

// ─────────────────────────── Scenario E — responsible gaming ───────────────────────────
const E: Record<string, Handler> = {
  async data_intel(ctx) {
    const pid = String(ctx.params.player_id ?? one<{ player_id: string }>("SELECT player_id FROM customers WHERE self_excluded = 0 AND rg_restricted = 0 AND kyc_status = 'verified' AND player_id IN (SELECT player_id FROM segment_memberships m JOIN segments s ON s.id = m.segment_id WHERE s.purpose IN ('marketing','membership')) ORDER BY player_id LIMIT 1")!.player_id);
    const ev = { event_id: `evt_rg_${ctx.runId}`, event_name: String(ctx.params.event ?? "self_exclusion_enabled"), player_id: pid, event_time: nowIso(), platform: "app" as const, properties: { duration_days: 180, source: "player_settings" } };
    if (ctx.simulation) return { summary: `Simulation: would ingest ${ev.event_name} for ${pid}`, output: { player_id: pid, event: ev } };
    const r = await ctx.tool("events.ingest", ev, () => ingestEvents([ev], "workflow", AGENT_ACTOR("data_intel")), (x) => `accepted ${x.accepted}, dup ${x.duplicates}`);
    return { summary: `Restriction event ${ev.event_name} ingested for ${pid}; mandatory protection applied synchronously by the compliance layer`, output: { player_id: pid, event: ev, ingest: r }, confidence: 1 };
  },
  async discovery(ctx) {
    upsertOpportunity(ctx, { key: `rg:${ctx.out.data_intel.player_id}:${nowIso().slice(0, 10)}`, title: `Protective action: ${ctx.out.data_intel.player_id}`, description: "Responsible gaming restriction received — verify enforcement.", category: "responsible_gaming", severity: "high", affected: 1, systems: ["cdp", "compliance"], evidence: [ctx.out.data_intel.event], risk: "low" });
    return { summary: "Protective workflow opened (verification, not targeting)", output: {}, confidence: 1 };
  },
  async customer_intel(ctx) {
    const pid = String(ctx.out.data_intel.player_id);
    const c = one<{ self_excluded: number; rg_restricted: number }>("SELECT self_excluded, rg_restricted FROM customers WHERE player_id = ?", pid)!;
    const ex = all("SELECT exclusion_type, created_at FROM exclusion_records WHERE player_id = ? AND active = 1", pid);
    const tag = one("SELECT 1 x FROM customer_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.player_id = ? AND t.key = 'rg_excluded'", pid);
    return { summary: `Customer 360 updated: self_excluded=${c.self_excluded}, rg_restricted=${c.rg_restricted}, ${ex.length} active exclusion(s), tag ${tag ? "applied" : "missing"}`, output: { flags: c, exclusions: ex, tag: !!tag }, confidence: 1 };
  },
  async decision() {
    return { summary: "Proposed: verify protection + protective service task (authorized, low risk)", output: { actions: [{ type: "verify_protection", risk: "low" }, { type: "create_protective_task", risk: "low", purpose: "protective" }] }, confidence: 1 };
  },
  async audience(ctx) {
    const pid = String(ctx.out.data_intel.player_id);
    const promo = all("SELECT s.name FROM segment_memberships m JOIN segments s ON s.id = m.segment_id WHERE m.player_id = ? AND s.purpose IN ('marketing','membership','regulated_promotion')", pid);
    const exits = all("SELECT s.name, h.reason FROM segment_membership_history h JOIN segments s ON s.id = h.segment_id WHERE h.player_id = ? AND h.reason LIKE 'compliance:%'", pid);
    return { summary: `Promotional segment memberships remaining: ${promo.length}; compliance exits recorded: ${exits.length}`, output: { remaining: promo, exits }, confidence: 1 };
  },
  async journey(ctx) {
    const pid = String(ctx.out.data_intel.player_id);
    const active = all("SELECT e.id, j.name, j.purpose FROM journey_executions e JOIN journeys j ON j.id = e.journey_id WHERE e.player_id = ? AND e.status IN ('active','waiting') AND j.purpose IN ('marketing','membership')", pid);
    return { summary: `Active promotional journey executions: ${active.length}`, output: { active }, confidence: 1 };
  },
  async compliance(ctx) {
    const pid = String(ctx.out.data_intel.player_id);
    const promo = evaluate({ playerIds: [pid], purpose: "marketing", channel: "sms", action: "message", context: "rg_verification", refId: ctx.runId })[0];
    const svc = evaluate({ playerIds: [pid], purpose: "protective", action: "targeting", context: "rg_verification", refId: ctx.runId })[0];
    const offer = evaluate({ playerIds: [pid], purpose: "membership", action: "offer", context: "rg_verification", refId: ctx.runId })[0];
    return { summary: `Marketing: ${promo.allowed ? "ALLOWED ⚠" : "blocked ✓"} · Incentives: ${offer.allowed ? "ALLOWED ⚠" : "blocked ✓"} · Protective contact: ${svc.allowed ? "allowed ✓" : "blocked"}`, output: { marketing: promo, incentives: offer, protective: svc, passed: !promo.allowed && !offer.allowed }, confidence: 1 };
  },
  async execution(ctx) {
    const pid = String(ctx.out.data_intel.player_id);
    const t = one<{ id: string }>("SELECT id FROM service_tickets WHERE player_id = ? AND category = 'responsible_gaming' ORDER BY created_at DESC LIMIT 1", pid);
    return { summary: t ? `Protective service task ${t.id} exists` : "No protective task (disabled in strategy)", output: { task: t?.id }, confidence: 1 };
  },
  async analytics(ctx) {
    const pid = String(ctx.out.data_intel.player_id);
    const a = one<{ details: string }>("SELECT details FROM audit_logs WHERE action = 'compliance.protection_applied' AND entity_id = ? ORDER BY seq DESC LIMIT 1", pid);
    const d = J.parse<{ latency_ms?: number; steps?: unknown[] }>(a?.details, {});
    if (!ctx.simulation) recordExecutionResult(ctx.strategy.strategyId, ctx.strategy.version, ctx.runId, { latency_ms: d.latency_ms });
    return { summary: `Protection applied in ${d.latency_ms ?? "?"} ms with ${d.steps?.length ?? 0} audited steps`, output: d, confidence: 1 };
  },
  async optimizer() {
    return { summary: "No optimization proposed — protective workflows are never optimized for engagement; latency within target", output: {}, confidence: 1 };
  },
};

export const HANDLERS: Record<string, Record<string, Handler>> = { provider_failure: A, kyc_assistance: B, membership_entitlements: C, channel_delivery: D, rg_protection: E };

/** Generic handlers shared by all scenarios. */
export const GENERIC: Record<string, Handler> = {
  async approval(ctx) {
    const actions = (ctx.out.decision?.actions as Array<{ type: string; risk: string; audience?: number; purpose?: string }>) ?? [];
    const comp = ctx.out.compliance as { passed?: boolean; content_issues?: unknown[] } | undefined;
    if (comp && comp.passed === false && ctx.scenario !== "rg_protection") return { summary: "Compliance failed — execution blocked", output: { blocked: true }, halt: "Compliance validation failed" };
    const evals = await ctx.tool("policy.evaluate", { mode: ctx.mode, actions: actions.length }, () => policyEvaluate(actions, ctx.mode), (r) => `${r.filter((x) => x.auto).length}/${r.length} auto-authorized`);
    const needsHuman = evals.filter((e) => !e.auto);
    if (ctx.simulation) return { summary: `Simulation: ${needsHuman.length} action(s) would require approval`, output: { evaluations: evals } };
    if (!needsHuman.length) return { summary: `All ${evals.length} actions authorized for automatic execution by policy`, output: { evaluations: evals, auto: true }, confidence: 1 };
    return { summary: `${needsHuman.length} action(s) require human approval: ${needsHuman.map((n) => n.type).join(", ")}`, output: { evaluations: evals, auto: false }, awaitApproval: true, confidence: 1 };
  },
};
