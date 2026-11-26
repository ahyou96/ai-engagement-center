import { all, J, one, run } from "../db";
import { activeProvider, streamLLM, ChatMsg, ToolDef } from "./provider";
import { overview, parseFilters, gamingFunnel } from "../metrics";
import { estimate, FIELDS, Rule, describeRule, RuleSchema } from "../segments";
import { customer360 } from "../cdp";
import { decideForPlayers, summarizeDecisions } from "../offers";
import { channelStats } from "../messaging";
import { can } from "../rbac";
import { id, nowIso, pct, round, hoursAgo } from "../util";
import { audit } from "../audit";
import type { SessionUser } from "../auth";

export type Part =
  | { type: "text"; text: string }
  | { type: "tool_start"; id: string; name: string; args: unknown }
  | { type: "tool_end"; id: string; name: string; summary: string; sources: string[]; ms: number }
  | { type: "table"; title: string; columns: string[]; rows: unknown[][]; source: string; kind: "verified" | "estimate" }
  | { type: "chart"; title: string; chartType: "bar" | "line" | "pie"; x: string[]; series: Array<{ name: string; data: number[] }>; source: string }
  | { type: "draft"; kind: "segment" | "campaign" | "journey"; title: string; payload: Record<string, unknown>; requires_confirmation: true }
  | { type: "suggestions"; items: string[] }
  | { type: "meta"; conversation_id: string; message_id: string; provider: string }
  | { type: "notice"; level: "info" | "warning"; text: string }
  | { type: "error"; message: string }
  | { type: "done" };

type ToolOut = { summary: string; data: unknown; parts?: Part[]; sources: string[] };

// ───────── natural-language → structured segment rules (mock parser; real LLMs call build_segment with rules) ─────────
const WORDNUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14, thirty: 30 };
const BLOCKED_TARGETING = /(\blos(s|ses|ing|t)\b|chas(e|ing)|vulnerab|problem gambl|financial (distress|difficult)|in debt|addict|heavy (bettor|gambler)|big (loser|spender)|bet (the )?most|wager(ing)? (most|intensity))/i;
export function parseSegment(text: string): { rule: Rule; explanation: string[]; refused?: string } {
  const t = text.toLowerCase();
  if (BLOCKED_TARGETING.test(t)) return { rule: { type: "group", op: "and", children: [] }, explanation: [], refused: "Segments based on losses, chasing, vulnerability or wagering intensity cannot be built for engagement. These signals may only be used for authorised responsible-gaming, compliance, fraud or accounting purposes — ask the Compliance team." };
  const days = (() => { const m = t.match(/(?:last|past|within)\s+(\d+|\w+)\s+days?/); if (m) return Number(m[1]) || WORDNUM[m[1]] || 7; if (/last week|past week|7d/.test(t)) return 7; if (/today|24h|last day/.test(t)) return 1; if (/month|30d/.test(t)) return 30; return 7; })();
  const c: Rule[] = []; const ex: string[] = [];
  if (/load(ing)?|launch/.test(t) && /fail|error|issue|problem|slow/.test(t)) { c.push({ type: "event", event: "game_launch_failed", op: "gte", count: 1, within_days: days }); ex.push(`game_launch_failed ≥ 1 in last ${days}d — event "game_launch_failed" captures failed game loads`); }
  if (/(unresolved|open|pending).{0,25}(ticket|case|complaint|cs|customer service)|(ticket|complaint)s?.{0,15}(unresolved|open)/.test(t)) { c.push({ type: "attr", field: "open_tickets", op: "gt", value: 0 }); ex.push("open_tickets > 0 — unresolved customer service tickets"); }
  const kyc = t.match(/kyc|verif/) ? (/(not started|never started)/.test(t) ? ["not_started"] : /fail/.test(t) ? ["failed"] : /(pending|incomplete|stuck|stalled|not (yet )?verified|unverified)/.test(t) ? ["pending", "failed", "in_review"] : /verified/.test(t) ? ["verified"] : null) : null;
  if (kyc) { c.push({ type: "attr", field: "kyc_status", op: "in", value: kyc }); ex.push(`kyc_status in ${kyc.join(", ")}`); }
  for (const os of ["ios", "android", "windows", "macos"]) if (new RegExp(`\\b${os}\\b`).test(t)) { c.push({ type: "attr", field: "os", op: "eq", value: os }); ex.push(`os = ${os}`); }
  const plat = t.match(/\b(app|h5|pc)\b(?: users| players)?/); if (plat && /(users|players|platform|on (the )?(app|h5|pc))/.test(t)) { c.push({ type: "attr", field: "primary_platform", op: "eq", value: plat[1] }); ex.push(`primary_platform = ${plat[1]}`); }
  const tiers = ["bronze", "silver", "gold", "platinum"].filter((x) => t.includes(x)); if (tiers.length) { c.push({ type: "attr", field: "vip_tier", op: "in", value: tiers }); ex.push(`membership tier in ${tiers.join(", ")}`); }
  const inactive = t.match(/(inactive|dormant|not active|haven'?t (played|logged in))(?:.*?(\d+)\s*days?)?/); if (inactive) { const d = Number(inactive[3] ?? 30); c.push({ type: "attr", field: "last_active_at", op: "older_than_days", value: d }); ex.push(`last_active_at older than ${d}d`); }
  if (/\bnew (users|players|members|registrations)/.test(t)) { c.push({ type: "attr", field: "registered_at", op: "within_last_days", value: Math.min(days, 30) }); ex.push(`registered within ${Math.min(days, 30)}d`); }
  if (/search/.test(t) && /(no result|nothing|fail|empty)/.test(t)) { c.push({ type: "event", event: "game_search_no_result", op: "gte", count: 1, within_days: days }); ex.push(`game_search_no_result ≥ 1 in ${days}d`); }
  if (/disconnect/.test(t)) { c.push({ type: "event", event: "game_disconnect", op: "gte", count: 1, within_days: days }); ex.push(`game_disconnect ≥ 1 in ${days}d`); }
  for (const cat of ["live_casino", "slots", "fishing", "table", "crash", "bingo", "sports"]) if (t.includes(cat.replace("_", " "))) { c.push({ type: "attr", field: "favorite_category", op: "eq", value: cat }); ex.push(`favourite category = ${cat}`); }
  const city = ["manila", "quezon city", "cebu city", "davao city", "makati", "pasig", "taguig", "baguio"].find((x) => t.includes(x)); if (city) { const v = city.replace(/\b\w/g, (s) => s.toUpperCase()); c.push({ type: "attr", field: "city", op: "eq", value: v }); ex.push(`city = ${v}`); }
  if (/filipino|tagalog/.test(t)) { c.push({ type: "attr", field: "language", op: "eq", value: "fil" }); ex.push("language = fil"); }
  return { rule: { type: "group", op: /\bor\b|either/.test(t) && c.length > 1 ? "or" : "and", children: c }, explanation: ex };
}

// ───────── tools ─────────
export const TOOL_DEFS: ToolDef[] = [
  { name: "query_metrics", description: "Overview KPIs (customer, gaming, engagement, AI, offers) for the last N days with optional platform/provider/channel filters", parameters: { type: "object", properties: { days: { type: "number" }, group: { type: "string", enum: ["customer", "gaming", "engagement", "ai", "offers"] }, platform: { type: "string" }, provider: { type: "string" } }, required: ["group"] } },
  { name: "provider_performance", description: "Launch success/failure rates by gaming provider over the last N hours", parameters: { type: "object", properties: { hours: { type: "number" } } } },
  { name: "gaming_funnel", description: "Gaming experience funnel impression→click→launch→session plus error codes and OS breakdown", parameters: { type: "object", properties: { days: { type: "number" } } } },
  { name: "build_segment", description: "Turn a natural-language audience description into structured segment rules and preview size. Returns a DRAFT; never saves.", parameters: { type: "object", properties: { description: { type: "string" }, purpose: { type: "string", enum: ["service", "membership", "marketing"] } }, required: ["description"] } },
  { name: "search_customers", description: "Find customers by player id or attributes (PII masked by role)", parameters: { type: "object", properties: { player_id: { type: "string" }, kyc_status: { type: "string" }, vip_tier: { type: "string" }, limit: { type: "number" } } } },
  { name: "get_customer", description: "Customer 360 summary for one player (service-oriented; masked by role)", parameters: { type: "object", properties: { player_id: { type: "string" } }, required: ["player_id"] } },
  { name: "list_opportunities", description: "Recent AI-discovered opportunities", parameters: { type: "object", properties: { status: { type: "string" } } } },
  { name: "kyc_funnel", description: "KYC status distribution, failure reasons and stalled counts", parameters: { type: "object", properties: {} } },
  { name: "channel_performance", description: "Delivery/read/click/cost by channel over last N hours", parameters: { type: "object", properties: { hours: { type: "number" } } } },
  { name: "check_offer_eligibility", description: "Simulate the deterministic entitlement engine for an offer on a segment (no issuance)", parameters: { type: "object", properties: { offer_id: { type: "string" }, segment_id: { type: "string" } }, required: ["offer_id"] } },
  { name: "compare_strategy_versions", description: "Version history, experiments and status for a strategy category", parameters: { type: "object", properties: { category: { type: "string", enum: ["provider_monitoring", "kyc_assistance", "membership_entitlements", "channel_routing", "rg_protection"] } }, required: ["category"] } },
  { name: "draft_campaign", description: "Draft a campaign (not saved) using an approved template; returns a preview requiring human confirmation", parameters: { type: "object", properties: { objective: { type: "string" }, segment_id: { type: "string" }, channel: { type: "string" } }, required: ["objective"] } },
  { name: "draft_journey", description: "Draft a journey outline (not saved) for a goal", parameters: { type: "object", properties: { goal: { type: "string" } }, required: ["goal"] } },
];

const fmtPct = (v: number | null | undefined) => (v == null ? "–" : `${round(v * 100, 1)}%`);

export function runTool(name: string, args: Record<string, unknown>, user: SessionUser): ToolOut {
  switch (name) {
    case "query_metrics": {
      const sp = new URLSearchParams({ days: String(args.days ?? 7) });
      if (args.platform) sp.set("platform", String(args.platform)); if (args.provider) sp.set("provider", String(args.provider));
      const o = overview(parseFilters(sp));
      const group = (String(args.group ?? "customer")) as "customer";
      const ms = (o as unknown as Record<string, Array<{ label: string; value: number | null; prev?: number | null; format: string; formula: string }>>)[group] ?? o.customer;
      const fmt = (m: { value: number | null; format: string }) => m.value == null ? "–" : m.format === "pct" ? fmtPct(m.value) : m.format === "ms" ? `${m.value} ms` : Number(m.value).toLocaleString();
      return { summary: `${ms.length} ${group} metrics for last ${args.days ?? 7}d`, data: ms.map((m) => ({ label: m.label, value: m.value, prev: m.prev })), sources: ["metrics.overview", "events", "customers", "messages"],
        parts: [{ type: "table", title: `${group[0].toUpperCase() + group.slice(1)} metrics — last ${args.days ?? 7} days`, columns: ["Metric", "Value", "Previous period", "Formula"], rows: ms.map((m) => [m.label, fmt(m), m.prev == null ? "–" : fmt({ value: m.prev, format: m.format }), m.formula]), source: "Platform database (verified)", kind: "verified" }] };
    }
    case "provider_performance": {
      const h = Number(args.hours ?? 24);
      const rows = all<{ name: string; l: number; f: number; load: number }>(`SELECT p.name, COUNT(*) l, SUM(e.event_name = 'game_launch_failed') f, ROUND(AVG(e.loading_duration)) load FROM events e JOIN gaming_providers p ON p.id = e.provider_id WHERE e.event_time >= ? AND e.event_name IN ('game_launch_success','game_launch_failed') GROUP BY p.id ORDER BY 1.0*f/l DESC`, hoursAgo(h));
      const top = rows.slice(0, 10);
      return { summary: `${rows.length} providers; worst ${top[0]?.name} ${pct(top[0]?.f ?? 0, top[0]?.l ?? 1)}%`, data: top, sources: ["events: game_launch_success|failed"], parts: [
        { type: "table", title: `Provider launch performance — last ${h}h`, columns: ["Provider", "Launches", "Failures", "Failure rate", "Avg load (ms)"], rows: top.map((r) => [r.name, r.l, r.f, `${pct(r.f, r.l)}%`, r.load]), source: "events (verified)", kind: "verified" },
        { type: "chart", title: "Failure rate by provider (%)", chartType: "bar", x: top.map((r) => r.name), series: [{ name: "Failure rate %", data: top.map((r) => pct(r.f, r.l)) }], source: "events" }] };
    }
    case "gaming_funnel": {
      const sp = new URLSearchParams({ days: String(args.days ?? 7) });
      const g = gamingFunnel(parseFilters(sp));
      return { summary: `Funnel ${g.funnel.map((s) => s.players).join(" → ")}`, data: g, sources: ["events"], parts: [
        { type: "chart", title: "Gaming experience funnel (players)", chartType: "bar", x: g.funnel.map((s) => s.step.replace("game_", "")), series: [{ name: "Players", data: g.funnel.map((s) => s.players) }], source: "events" },
        { type: "table", title: "Launch failures by error code", columns: ["Error code", "Count"], rows: (g.errors as Array<{ k: string; n: number }>).map((e) => [e.k, e.n]), source: "events (verified)", kind: "verified" }] };
    }
    case "build_segment": {
      const p = parseSegment(String(args.description ?? ""));
      if (p.refused) return { summary: "Refused by policy", data: { refused: p.refused }, sources: ["compliance policy"], parts: [{ type: "notice", level: "warning", text: p.refused }] };
      const rule = args.rules ? RuleSchema.parse(args.rules) : p.rule;
      if (rule.type === "group" && !rule.children.length) return { summary: "Could not map description to known fields", data: { fields: Object.keys(FIELDS) }, sources: [] };
      const purpose = String(args.purpose ?? "service");
      const est = estimate(rule, purpose);
      return { summary: `${est.count} matching players (${round(est.share * 100, 1)}%)`, data: { rule, count: est.count }, sources: ["customers", "events", "segment compiler"], parts: [
        { type: "draft", kind: "segment", title: `Segment draft: ${String(args.description).slice(0, 60)}`, payload: { name: String(args.description).slice(0, 60), purpose, rules: rule, explanation: p.explanation, description: describeRule(rule), estimated: est.count }, requires_confirmation: true },
        { type: "table", title: "Sample matching players (preview)", columns: ["Player", "Stage", "KYC", "Tier", "Platform", "Launch fails 7d", "Open tickets"], rows: (est.sample as Array<Record<string, unknown>>).map((s) => [s.player_id, s.lifecycle_stage, s.kyc_status, s.vip_tier, s.primary_platform, s.launch_failures_7d, s.open_tickets]), source: "customers (verified)", kind: "verified" }] };
    }
    case "search_customers": {
      const w: string[] = ["1=1"]; const p: unknown[] = [];
      if (args.player_id) { w.push("player_id = ?"); p.push(args.player_id); } if (args.kyc_status) { w.push("kyc_status = ?"); p.push(args.kyc_status); } if (args.vip_tier) { w.push("vip_tier = ?"); p.push(args.vip_tier); }
      const rows = all<Record<string, unknown>>(`SELECT player_id, display_name, lifecycle_stage, kyc_status, vip_tier, primary_platform, last_active_at FROM customers WHERE ${w.join(" AND ")} LIMIT ?`, ...p, Math.min(25, Number(args.limit ?? 10)));
      const pii = can(user.role_id, "pii.read");
      return { summary: `${rows.length} customers`, data: rows.map((r) => ({ ...r, display_name: pii ? r.display_name : "•••" })), sources: ["customers"], parts: [{ type: "table", title: "Customers", columns: ["Player", "Name", "Stage", "KYC", "Tier", "Platform"], rows: rows.map((r) => [r.player_id, pii ? r.display_name : "masked", r.lifecycle_stage, r.kyc_status, r.vip_tier, r.primary_platform]), source: "customers (PII masked by role)", kind: "verified" }] };
    }
    case "get_customer": {
      const c = customer360(String(args.player_id), user.role_id);
      audit({ type: "user", id: user.email }, "data.access.customer360", "customer", String(args.player_id), { via: "copilot" });
      return { summary: c.summary.text.slice(0, 120), data: { profile: c.profile, summary: c.summary, tags: c.tags, segments: c.segments.length, tickets: c.tickets.length }, sources: ["customers", "events", "service_tickets"], parts: [{ type: "table", title: `Customer ${args.player_id}`, columns: ["Field", "Value"], rows: ["lifecycle_stage", "kyc_status", "vip_tier", "primary_platform", "os", "launch_failures_7d", "avg_load_ms", "open_tickets"].map((k) => [k, String((c.profile as Record<string, unknown>)[k])]), source: "Customer 360 (verified)", kind: "verified" }] };
    }
    case "list_opportunities": {
      const rows = all<Record<string, unknown>>(`SELECT id, title, severity, status, affected_users, detected_at FROM opportunities ${args.status ? "WHERE status = ?" : ""} ORDER BY detected_at DESC LIMIT 10`, ...(args.status ? [args.status] : []));
      return { summary: `${rows.length} opportunities`, data: rows, sources: ["opportunities"], parts: [{ type: "table", title: "Recent opportunities", columns: ["Title", "Severity", "Status", "Affected", "Detected"], rows: rows.map((r) => [r.title, r.severity, r.status, r.affected_users, String(r.detected_at).slice(0, 16)]), source: "opportunities (verified)", kind: "verified" }] };
    }
    case "kyc_funnel": {
      const st = all<{ k: string; n: number }>("SELECT kyc_status k, COUNT(*) n FROM customers GROUP BY k ORDER BY n DESC");
      const reasons = all<{ k: string; n: number }>("SELECT kyc_failure_reason k, COUNT(*) n FROM customers WHERE kyc_status = 'failed' GROUP BY k ORDER BY n DESC");
      const stalled = one<{ n: number }>("SELECT COUNT(*) n FROM customers WHERE kyc_status IN ('pending','failed') AND kyc_updated_at < ?", hoursAgo(24))!.n;
      return { summary: `${stalled} stalled; top failure ${reasons[0]?.k}`, data: { st, reasons, stalled }, sources: ["customers.kyc_status"], parts: [
        { type: "chart", title: "KYC status distribution", chartType: "pie", x: st.map((s) => s.k), series: [{ name: "Players", data: st.map((s) => s.n) }], source: "customers" },
        { type: "table", title: "KYC failure reasons", columns: ["Reason", "Players"], rows: reasons.map((r) => [r.k, r.n]), source: "customers (verified)", kind: "verified" }] };
    }
    case "channel_performance": {
      const rows = channelStats(Number(args.hours ?? 24 * 7));
      return { summary: `${rows.length} channels`, data: rows, sources: ["messages", "delivery_events"], parts: [{ type: "table", title: "Channel performance (mock delivery receipts)", columns: ["Channel", "Sent", "Delivery", "Read", "CTR", "Cost"], rows: rows.map((r) => [r.channel, r.total, `${pct(r.delivered, r.total)}%`, `${pct(r.read, r.delivered)}%`, `${pct(r.clicked, r.delivered)}%`, r.cost]), source: "messages (simulated delivery)", kind: "estimate" }] };
    }
    case "check_offer_eligibility": {
      const ids = all<{ player_id: string }>("SELECT player_id FROM segment_memberships WHERE segment_id = ? LIMIT 2000", args.segment_id ?? "seg_02").map((r) => r.player_id);
      const { decisions, strategy } = decideForPlayers(String(args.offer_id), ids);
      const s = summarizeDecisions(decisions);
      return { summary: `None ${s.distribution.none}, reduced ${s.distribution.reduced}, standard ${s.distribution.standard}, enhanced ${s.distribution.enhanced}`, data: s, sources: ["offer engine (simulation)", `strategy v${strategy.version}`], parts: [
        { type: "chart", title: "Entitlement decision distribution (simulation)", chartType: "bar", x: ["No offer", "Reduced", "Standard", "Enhanced"], series: [{ name: "Players", data: [s.distribution.none, s.distribution.reduced, s.distribution.standard, s.distribution.enhanced] }], source: "offer engine" },
        { type: "table", title: "Sample decisions with reasons", columns: ["Player", "Outcome", "Amount", "Reason"], rows: decisions.slice(0, 8).map((d) => [d.player_id, d.outcome, d.approved_amount, d.reason]), source: "deterministic policy engine", kind: "verified" }] };
    }
    case "compare_strategy_versions": {
      const rows = all<Record<string, unknown>>("SELECT v.version, v.status, v.change_summary, v.created_by, v.created_at, (SELECT p_value FROM experiment_results r WHERE r.experiment_id = v.experiment_id AND r.variant = 'candidate') p FROM strategy_versions v JOIN strategies s ON s.id = v.strategy_id WHERE s.category = ? ORDER BY v.version", args.category);
      return { summary: `${rows.length} versions`, data: rows, sources: ["strategy_versions", "experiment_results"], parts: [{ type: "table", title: `Strategy history: ${args.category}`, columns: ["Version", "Status", "Change", "p-value", "Created"], rows: rows.map((r) => [`v${r.version}`, r.status, r.change_summary, r.p == null ? "–" : Number(r.p).toFixed(4), String(r.created_at).slice(0, 10)]), source: "Strategy Registry (verified)", kind: "verified" }] };
    }
    case "draft_campaign": {
      const ch = String(args.channel ?? "inbox");
      const tpl = one<{ id: string; name: string; body: string; purpose: string }>("SELECT id, name, body, purpose FROM message_templates WHERE channel = ? AND status = 'approved' AND purpose = 'service' LIMIT 1", ch);
      const seg = args.segment_id ? one<{ id: string; name: string; member_count: number }>("SELECT id, name, member_count FROM segments WHERE id = ?", args.segment_id) : null;
      return { summary: "Campaign draft prepared (not saved)", data: { tpl, seg }, sources: ["message_templates", "segments"], parts: [{ type: "draft", kind: "campaign", title: `Campaign draft: ${args.objective}`, payload: { name: String(args.objective).slice(0, 60), objective: "service_communication", segment_id: seg?.id ?? null, segment_name: seg?.name, audience: seg?.member_count, channels: [ch], template_id: tpl?.id, template_preview: tpl?.body }, requires_confirmation: true }] };
    }
    case "draft_journey": {
      return { summary: "Journey outline drafted (not saved)", data: {}, sources: ["journey catalog"], parts: [{ type: "draft", kind: "journey", title: `Journey draft: ${String(args.goal).slice(0, 60)}`, payload: { goal: args.goal, steps: ["Trigger: segment entry", "Condition: channel consent", "Action: send approved service message", "Wait: strategy parameter", "Condition: goal reached? → exit", "Action: follow-up / create ticket", "End"], note: "Open Journey Builder to configure and validate; publishing follows approval rules." }, requires_confirmation: true }] };
    }
  }
  return { summary: `Unknown tool ${name}`, data: null, sources: [] };
}

// ───────── mock planner (deterministic, offline) ─────────
function plan(q: string): Array<{ name: string; args: Record<string, unknown> }> {
  const t = q.toLowerCase();
  const days = Number(t.match(/(\d+)\s*days?/)?.[1] ?? (/(month|30)/.test(t) ? 30 : /today|24h/.test(t) ? 1 : 7));
  if (BLOCKED_TARGETING.test(t) && /(segment|target|find|users|players|offer|campaign|bonus)/.test(t)) return [{ name: "build_segment", args: { description: q } }];
  if (/(segment|audience|find (users|players)|users who|players who|build a list)/.test(t)) return [{ name: "build_segment", args: { description: q, purpose: /market|promo|tournament/.test(t) ? "marketing" : /member/.test(t) ? "membership" : "service" } }];
  const pid = q.match(/\bP\d{6}\b/)?.[0];
  if (pid) return [{ name: "get_customer", args: { player_id: pid } }];
  const out: Array<{ name: string; args: Record<string, unknown> }> = [];
  if (/provider|launch|loading|game fail/.test(t)) out.push({ name: "provider_performance", args: { hours: days === 7 && !/week|7/.test(t) ? 24 : days * 24 } });
  if (/funnel|discovery|search|game experience/.test(t)) out.push({ name: "gaming_funnel", args: { days } });
  if (/kyc|verification/.test(t)) out.push({ name: "kyc_funnel", args: {} });
  if (/channel|sms|delivery|whatsapp|viber|email|push/.test(t)) out.push({ name: "channel_performance", args: { hours: days * 24 } });
  if (/opportunit|anomal|what.*wrong|issues?/.test(t)) out.push({ name: "list_opportunities", args: {} });
  if (/strateg|version|optimi/.test(t)) out.push({ name: "compare_strategy_versions", args: { category: /kyc/.test(t) ? "kyc_assistance" : /channel|sms/.test(t) ? "channel_routing" : /offer|entitle|member/.test(t) ? "membership_entitlements" : /rg|responsible/.test(t) ? "rg_protection" : "provider_monitoring" } });
  if (/(entitlement|offer|benefit|eligib)/.test(t) && !/strateg/.test(t)) out.push({ name: "check_offer_eligibility", args: { offer_id: "off_member_monthly", segment_id: "seg_02" } });
  if (/draft.*campaign|campaign.*draft|create (a )?campaign/.test(t)) out.push({ name: "draft_campaign", args: { objective: q, channel: /sms/.test(t) ? "sms" : /push/.test(t) ? "app_push" : "inbox", segment_id: /kyc/.test(t) ? "seg_01" : /launch|load/.test(t) ? "seg_24" : undefined } });
  if (/journey|automation|workflow draft/.test(t)) out.push({ name: "draft_journey", args: { goal: q } });
  if (/report|dashboard|overview|kpi|metric|dau|mau|active users|how are we/.test(t) || !out.length) {
    const group = /gaming|game/.test(t) ? "gaming" : /message|engagement|campaign/.test(t) ? "engagement" : /ai|agent/.test(t) ? "ai" : /offer|entitle/.test(t) ? "offers" : "customer";
    out.push({ name: "query_metrics", args: { group, days } });
  }
  return out.slice(0, 3);
}

function narrate(q: string, results: Array<{ name: string; out: ToolOut }>): { text: string; suggestions: string[] } {
  const lines: string[] = [];
  const sugg = new Set<string>();
  for (const { name, out } of results) {
    const d = out.data as Record<string, unknown>;
    switch (name) {
      case "provider_performance": { const rows = d as unknown as Array<{ name: string; l: number; f: number; load: number }>; const w = rows[0];
        lines.push(`**Verified:** ${w?.name} has the highest launch failure rate at **${pct(w?.f ?? 0, w?.l ?? 1)}%** (${w?.f} of ${w?.l} launches, avg load ${w?.load} ms). The next provider is at ${pct(rows[1]?.f ?? 0, rows[1]?.l ?? 1)}%.`);
        lines.push(`**Assumption:** a concentration of \`PROVIDER_TIMEOUT\` errors usually points to provider-side latency — this needs confirmation from the provider before it is treated as the cause.`);
        sugg.add("Which devices and games are affected?").add("Run the provider failure workflow").add("Draft a service notice for affected players"); break; }
      case "gaming_funnel": { const f = (d as { funnel: Array<{ step: string; players: number }> }).funnel; const i = f.findIndex((s) => s.step === "game_launch_success");
        lines.push(`**Verified:** funnel ${f.map((s) => `${s.step.replace("game_", "")} ${s.players.toLocaleString()}`).join(" → ")}. The biggest drop is between launch start and launch success (${pct(f[i]?.players ?? 0, f[i - 1]?.players ?? 1)}% of launching players succeed).`); sugg.add("Break down launch failures by OS"); break; }
      case "kyc_funnel": { const x = d as { stalled: number; reasons: Array<{ k: string; n: number }> };
        lines.push(`**Verified:** ${x.stalled.toLocaleString()} players are stalled in KYC for more than 24h. The top failure reason is **${x.reasons[0]?.k}** (${x.reasons[0]?.n}).`); sugg.add("Build a segment of stalled KYC users").add("Run the KYC assistance workflow"); break; }
      case "channel_performance": { const rows = d as unknown as Array<{ channel: string; total: number; delivered: number; cost: number }>; const s = rows.find((r) => r.channel === "sms");
        if (s) lines.push(`**Verified (mock receipts):** SMS delivered ${pct(s.delivered, s.total)}% of ${s.total.toLocaleString()} messages. ${rows.filter((r) => r.channel !== "sms" && r.total > 50).map((r) => `${r.channel} ${pct(r.delivered, r.total)}%`).join(", ")}.`);
        sugg.add("Compare delivery cost per channel").add("Run the channel delivery recovery workflow"); break; }
      case "build_segment": {
        if ((d as { refused?: string }).refused) { lines.push(`I can't build that segment. ${(d as { refused: string }).refused}`); sugg.add("Find players with unresolved service tickets"); break; }
        const parts = out.parts?.find((p) => p.type === "draft") as Extract<Part, { type: "draft" }> | undefined;
        if (!parts) { lines.push("I couldn't map that description to known profile fields or events. Try mentioning KYC status, platform, OS, tier, launch failures, tickets or inactivity."); break; }
        lines.push(`I translated your description into structured rules:\n\n${(parts.payload.explanation as string[]).map((e) => `- ${e}`).join("\n")}\n\n**Verified:** ${Number(parts.payload.estimated).toLocaleString()} players match today${parts.payload.purpose !== "service" ? " (mandatory compliance exclusions applied)" : ""}. Review the draft below and confirm to save it — nothing is saved until you do.`);
        sugg.add("Draft a service journey for this segment").add("What channels can reach them?"); break; }
      case "get_customer": lines.push(`**Customer summary (service-oriented):** ${(d as { summary: { text: string } }).summary.text}`); sugg.add("Show this player's recent messages"); break;
      case "list_opportunities": lines.push(`**Verified:** ${(d as unknown as unknown[]).length} recent opportunities are listed below; open Opportunity Finder to run their workflows.`); break;
      case "compare_strategy_versions": { const rows = d as unknown as Array<{ version: number; status: string; change_summary: string }>; const a = rows.find((r) => r.status === "active");
        lines.push(`**Verified:** ${rows.length} versions in the registry; **v${a?.version}** is active ("${a?.change_summary}"). Improvements are only promoted after a significance test against the active version.`); break; }
      case "check_offer_eligibility": { const s = d as { distribution: Record<string, number>; total_amount: number };
        lines.push(`**Simulation (nothing issued):** No ${s.distribution.none}, Reduced ${s.distribution.reduced}, Standard ${s.distribution.standard}, Enhanced ${s.distribution.enhanced}; total PHP ${s.total_amount.toLocaleString()}. Decisions use tier, tenure, KYC, budget and existing entitlements only — never deposits, losses or wagering.`); break; }
      case "query_metrics": { const ms = d as unknown as Array<{ label: string; value: number | null; prev?: number | null }>;
        lines.push(`**Verified:** here are the requested KPIs from the platform database. ${ms.slice(0, 3).map((m) => `${m.label}: ${m.value == null ? "–" : m.value < 1 && m.value > 0 ? fmtPct(m.value) : Number(m.value).toLocaleString()}`).join(" · ")}.`);
        sugg.add("Show gaming metrics").add("Any anomalies this week?"); break; }
      case "draft_campaign": lines.push("I prepared a **campaign draft** using an approved service template. It is not saved; confirming opens it in the Campaign wizard where validation and approval apply."); break;
      case "draft_journey": lines.push("Here's a **journey outline**. Journeys are built and validated in Journey Builder; service journeys can be published by authorised users, promotional ones need approval."); break;
    }
  }
  if (!lines.length) lines.push(`I looked at the platform data for "${q}".`);
  lines.push("\n_Simulated AI response (mock provider) — figures come from the platform database; narrative is template-generated._");
  return { text: lines.join("\n\n"), suggestions: [...sugg].slice(0, 3) };
}

const SYSTEM_PROMPT = `You are the AI Copilot of an AI Customer Engagement Platform for an online gaming operator.
Use tools for every factual statement and cite which tool/data you used. Label statements as Verified (from tools), Estimate, Assumption, or Unavailable.
Never propose targeting based on losses, chasing, vulnerability, financial distress or wagering intensity; such data is restricted to RG/compliance/fraud/accounting.
Segments, campaigns and journeys you produce are DRAFTS that require human confirmation. Keep answers concise; use markdown.`;

/** Streams a copilot turn. Writes each part via `emit`; persists the conversation. */
export async function copilotTurn(p: { user: SessionUser; conversationId?: string; message: string; signal: AbortSignal; emit: (p: Part) => void }) {
  const t = nowIso();
  let cid = p.conversationId;
  if (!cid || !one("SELECT 1 FROM copilot_conversations WHERE id = ? AND user_id = ?", cid, p.user.id)) {
    cid = id("conv");
    run("INSERT INTO copilot_conversations (id, user_id, title, created_at, updated_at) VALUES (?,?,?,?,?)", cid, p.user.id, p.message.slice(0, 60), t, t);
  }
  run("INSERT INTO copilot_messages (id, conversation_id, role, content, parts, created_at) VALUES (?,?,?,?,?,?)", id("cm"), cid, "user", p.message, "[]", t);
  const mid = id("cm");
  const provider = activeProvider();
  const parts: Part[] = [];
  const emit = (x: Part) => { if (x.type !== "text") parts.push(x); p.emit(x); };
  let text = "";
  emit({ type: "meta", conversation_id: cid, message_id: mid, provider });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, process.env.AEC_FAST === "1" ? 0 : ms));
  try {
    if (provider === "mock") {
      const calls = plan(p.message);
      const results: Array<{ name: string; out: ToolOut }> = [];
      for (const c of calls) {
        if (p.signal.aborted) throw new Error("cancelled");
        const tid = id("tc"); const t0 = Date.now();
        emit({ type: "tool_start", id: tid, name: c.name, args: c.args });
        await sleep(250);
        const out = runTool(c.name, c.args, p.user);
        emit({ type: "tool_end", id: tid, name: c.name, summary: out.summary, sources: out.sources, ms: Date.now() - t0 });
        results.push({ name: c.name, out });
      }
      const n = narrate(p.message, results);
      for (const tok of n.text.match(/\S+\s*|\s+/g) ?? []) { if (p.signal.aborted) throw new Error("cancelled"); text += tok; p.emit({ type: "text", text: tok }); await sleep(12); }
      for (const r of results) for (const part of r.out.parts ?? []) emit(part);
      if (n.suggestions.length) emit({ type: "suggestions", items: n.suggestions });
    } else {
      const history = all<{ role: string; content: string }>("SELECT role, content FROM copilot_messages WHERE conversation_id = ? AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT 12", cid).reverse();
      const msgs: ChatMsg[] = history.map((h) => ({ role: h.role as "user", content: h.content }));
      for (let step = 0; step < 5; step++) {
        const calls: Array<{ id: string; name: string; args: Record<string, unknown> }> = []; let stepText = "";
        for await (const ch of streamLLM(provider, SYSTEM_PROMPT, msgs, TOOL_DEFS, p.signal)) {
          if (ch.type === "text") { stepText += ch.text; text += ch.text; p.emit({ type: "text", text: ch.text }); }
          if (ch.type === "tool_call") calls.push(ch);
        }
        if (!calls.length) break;
        msgs.push({ role: "assistant_tool_calls", content: stepText, calls });
        for (const c of calls) {
          const t0 = Date.now(); emit({ type: "tool_start", id: c.id, name: c.name, args: c.args });
          let out: ToolOut;
          try { out = runTool(c.name, c.args, p.user); } catch (e) { out = { summary: `error: ${(e as Error).message}`, data: null, sources: [] }; }
          emit({ type: "tool_end", id: c.id, name: c.name, summary: out.summary, sources: out.sources, ms: Date.now() - t0 });
          for (const part of out.parts ?? []) emit(part);
          msgs.push({ role: "tool", call_id: c.id, name: c.name, content: JSON.stringify({ summary: out.summary, data: out.data }).slice(0, 8000) });
        }
      }
    }
    run("INSERT INTO copilot_messages (id, conversation_id, role, content, parts, status, provider, created_at) VALUES (?,?,?,?,?,?,?,?)", mid, cid, "assistant", text, J.str(parts), "complete", provider, nowIso());
  } catch (e) {
    const cancelled = p.signal.aborted || (e as Error).message === "cancelled";
    run("INSERT INTO copilot_messages (id, conversation_id, role, content, parts, status, provider, created_at) VALUES (?,?,?,?,?,?,?,?)", mid, cid, "assistant", text, J.str(parts), cancelled ? "cancelled" : "error", provider, nowIso());
    if (!cancelled) p.emit({ type: "error", message: (e as Error).message });
  }
  run("UPDATE copilot_conversations SET updated_at = ? WHERE id = ?", nowIso(), cid);
  audit({ type: "user", id: p.user.email }, "copilot.turn", "copilot_conversation", cid, { provider, chars: text.length });
  p.emit({ type: "done" });
  return cid;
}
