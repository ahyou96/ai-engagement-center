import { z } from "zod";
import { all, db, J, one, run, tx } from "./db";
import { audit, Actor, SYSTEM } from "./audit";
import { HttpError, id, nowIso, ORG_ID } from "./util";
import { publish } from "./stream";

/** Whitelisted, documented fields usable in segment rules (prevents SQL injection; drives the builder UI and AI builder). */
export const FIELDS: Record<string, { label: string; type: "string" | "number" | "date" | "bool" | "enum"; options?: string[]; restricted?: string; description: string }> = {
  lifecycle_stage: { label: "Lifecycle stage", type: "enum", options: ["new", "active", "engaged", "at_risk", "dormant", "churned"], description: "Derived from registration and last activity" },
  kyc_status: { label: "KYC status", type: "enum", options: ["not_started", "pending", "in_review", "failed", "verified"], description: "Identity verification status" },
  vip_tier: { label: "Membership tier", type: "enum", options: ["standard", "bronze", "silver", "gold", "platinum"], description: "Membership level" },
  primary_platform: { label: "Primary platform", type: "enum", options: ["app", "h5", "pc"], description: "Most used platform" },
  device_type: { label: "Device type", type: "enum", options: ["mobile", "tablet", "desktop"], description: "Primary device" },
  os: { label: "Operating system", type: "enum", options: ["android", "ios", "windows", "macos"], description: "Primary OS" },
  city: { label: "City", type: "string", description: "City of residence" },
  language: { label: "Language", type: "enum", options: ["en", "fil", "zh"], description: "Preferred language" },
  age: { label: "Age", type: "number", description: "Age in years (eligibility only)" },
  registered_at: { label: "Registered", type: "date", description: "Registration timestamp" },
  last_active_at: { label: "Last active", type: "date", description: "Last activity timestamp" },
  kyc_updated_at: { label: "KYC updated", type: "date", description: "Last KYC status change" },
  account_status: { label: "Account status", type: "enum", options: ["active", "suspended", "closed"], description: "Account state" },
  gaming_sessions_30d: { label: "Gaming sessions (30d)", type: "number", description: "Game sessions in last 30 days" },
  gaming_active_days_30d: { label: "Gaming active days (30d)", type: "number", description: "Distinct days with a game session" },
  favorite_category: { label: "Favourite game category", type: "enum", options: ["slots", "live_casino", "table", "fishing", "crash", "bingo", "sports"], description: "Most played category" },
  favorite_provider_id: { label: "Favourite provider", type: "string", description: "Most played provider id" },
  launch_failures_7d: { label: "Game launch failures (7d)", type: "number", description: "Failed game launches in last 7 days" },
  avg_load_ms: { label: "Avg game load (ms)", type: "number", description: "Average game loading duration" },
  search_no_result_7d: { label: "Search no-result (7d)", type: "number", description: "Searches with zero results" },
  open_tickets: { label: "Open service tickets", type: "number", description: "Unresolved customer service tickets" },
  tickets_30d: { label: "Tickets (30d)", type: "number", description: "Service tickets in last 30 days" },
  profile_completeness: { label: "Profile completeness", type: "number", description: "0–1 share of populated profile fields" },
  self_excluded: { label: "Self-excluded", type: "bool", description: "Compliance flag (exclusion use only)" },
  rg_restricted: { label: "RG restricted", type: "bool", description: "Compliance flag (exclusion use only)" },
  marketing_opt_out: { label: "Marketing opt-out", type: "bool", description: "Consent flag" },
};

const attrOps = ["eq", "neq", "gt", "gte", "lt", "lte", "in", "not_in", "contains", "is_null", "not_null", "within_last_days", "older_than_days"] as const;
export type Rule =
  | { type: "group"; op: "and" | "or"; negate?: boolean; children: Rule[] }
  | { type: "attr"; field: string; op: (typeof attrOps)[number]; value?: unknown }
  | { type: "event"; event: string; op: "gte" | "lte" | "eq"; count: number; within_days: number; provider_id?: string }
  | { type: "tag"; tag: string; has: boolean }
  | { type: "segment"; segment_id: string; in: boolean }
  | { type: "attr_change"; field: string; to: string; within_days: number };

export const RuleSchema: z.ZodType<Rule> = z.lazy(() => z.union([
  z.object({ type: z.literal("group"), op: z.enum(["and", "or"]), negate: z.boolean().optional(), children: z.array(RuleSchema) }),
  z.object({ type: z.literal("attr"), field: z.string(), op: z.enum(attrOps), value: z.unknown().optional() }),
  z.object({ type: z.literal("event"), event: z.string(), op: z.enum(["gte", "lte", "eq"]), count: z.number().int().min(0), within_days: z.number().min(0.01).max(365), provider_id: z.string().optional() }),
  z.object({ type: z.literal("tag"), tag: z.string(), has: z.boolean() }),
  z.object({ type: z.literal("segment"), segment_id: z.string(), in: z.boolean() }),
  z.object({ type: z.literal("attr_change"), field: z.string(), to: z.string(), within_days: z.number().min(0.01).max(365) }),
])) as z.ZodType<Rule>;

const cmp: Record<string, string> = { eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" };

export function compile(rule: Rule, now = new Date(), depth = 0): { sql: string; params: unknown[] } {
  if (depth > 8) throw new HttpError(400, "Rule nesting too deep");
  switch (rule.type) {
    case "group": {
      if (!rule.children.length) return { sql: rule.negate ? "0" : "1", params: [] };
      const parts = rule.children.map((c) => compile(c, now, depth + 1));
      const sql = `(${parts.map((p) => p.sql).join(rule.op === "and" ? " AND " : " OR ")})`;
      return { sql: rule.negate ? `NOT ${sql}` : sql, params: parts.flatMap((p) => p.params) };
    }
    case "attr": {
      const f = FIELDS[rule.field];
      if (!f) throw new HttpError(400, `Unknown field ${rule.field}`);
      const col = `c.${rule.field}`;
      switch (rule.op) {
        case "is_null": return { sql: `${col} IS NULL`, params: [] };
        case "not_null": return { sql: `${col} IS NOT NULL`, params: [] };
        case "in": case "not_in": {
          const vals = Array.isArray(rule.value) ? rule.value : [rule.value];
          if (!vals.length) return { sql: rule.op === "in" ? "0" : "1", params: [] };
          return { sql: `${col} ${rule.op === "in" ? "IN" : "NOT IN"} (${vals.map(() => "?").join(",")})`, params: vals };
        }
        case "contains": return { sql: `${col} LIKE ?`, params: [`%${String(rule.value)}%`] };
        case "within_last_days": return { sql: `${col} >= ?`, params: [new Date(now.getTime() - Number(rule.value) * 86400_000).toISOString()] };
        case "older_than_days": return { sql: `${col} < ?`, params: [new Date(now.getTime() - Number(rule.value) * 86400_000).toISOString()] };
        default: {
          let v = rule.value;
          if (f.type === "bool") v = v === true || v === "true" || v === 1 ? 1 : 0;
          if (f.type === "number") v = Number(v);
          return { sql: `${col} ${cmp[rule.op]} ?`, params: [v] };
        }
      }
    }
    case "event": {
      const since = new Date(now.getTime() - rule.within_days * 86400_000).toISOString();
      const extra = rule.provider_id ? " AND e.provider_id = ?" : "";
      const sub = `(SELECT COUNT(*) FROM events e WHERE e.player_id = c.player_id AND e.event_name = ? AND e.event_time >= ?${extra})`;
      return { sql: `${sub} ${cmp[rule.op]} ?`, params: [rule.event, since, ...(rule.provider_id ? [rule.provider_id] : []), rule.count] };
    }
    case "tag": {
      const sub = `EXISTS (SELECT 1 FROM customer_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.player_id = c.player_id AND t.key = ? AND (ct.expires_at IS NULL OR ct.expires_at > ?))`;
      return { sql: rule.has ? sub : `NOT ${sub}`, params: [rule.tag, now.toISOString()] };
    }
    case "segment": {
      const sub = `EXISTS (SELECT 1 FROM segment_memberships sm WHERE sm.player_id = c.player_id AND sm.segment_id = ?)`;
      return { sql: rule.in ? sub : `NOT ${sub}`, params: [rule.segment_id] };
    }
    case "attr_change": {
      if (!FIELDS[rule.field]) throw new HttpError(400, `Unknown field ${rule.field}`);
      return { sql: `EXISTS (SELECT 1 FROM customer_attribute_history h WHERE h.player_id = c.player_id AND h.attribute = ? AND h.new_value = ? AND h.changed_at >= ?)`,
        params: [rule.field, rule.to, new Date(now.getTime() - rule.within_days * 86400_000).toISOString()] };
    }
  }
}

const PROMO_EXCLUSION = " AND c.self_excluded = 0 AND c.rg_restricted = 0 AND c.marketing_opt_out = 0 AND c.account_status = 'active'";
export const isPromoPurpose = (p?: string) => p === "membership" || p === "marketing" || p === "regulated_promotion";

/** Promotional segments always apply mandatory compliance exclusions (cannot be overridden by rules). */
export function matchIds(rule: Rule, onlyPlayer?: string, purpose?: string): string[] {
  const { sql, params } = compile(RuleSchema.parse(rule));
  const extra = (onlyPlayer ? " AND c.player_id = ?" : "") + (isPromoPurpose(purpose) ? PROMO_EXCLUSION : "");
  return db().prepare(`SELECT c.player_id FROM customers c WHERE c.org_id = ? AND ${sql}${extra}`).raw().all(ORG_ID, ...params, ...(onlyPlayer ? [onlyPlayer] : [])).map((r) => (r as string[])[0]);
}

export function estimate(rule: Rule, purpose?: string) {
  const c0 = compile(RuleSchema.parse(rule));
  const sql = c0.sql + (isPromoPurpose(purpose) ? PROMO_EXCLUSION : ""); const params = c0.params;
  const count = (db().prepare(`SELECT COUNT(*) FROM customers c WHERE c.org_id = ? AND ${sql}`).raw().get(ORG_ID, ...params) as number[])[0];
  const sample = db().prepare(`SELECT c.player_id, c.display_name, c.lifecycle_stage, c.kyc_status, c.vip_tier, c.primary_platform, c.launch_failures_7d, c.open_tickets, c.last_active_at FROM customers c WHERE c.org_id = ? AND ${sql} ORDER BY c.last_active_at DESC LIMIT 10`).all(ORG_ID, ...params);
  const total = (db().prepare("SELECT COUNT(*) FROM customers WHERE org_id = ?").raw().get(ORG_ID) as number[])[0];
  return { count, total, share: total ? count / total : 0, sample };
}

export type SegmentRow = { id: string; name: string; description: string | null; segment_type: string; purpose: string; rules: string; version: number; status: string; member_count: number; refresh_schedule: string | null; last_evaluated_at: string | null; created_at: string; updated_at: string; ai_generated: number; created_by: string | null };

export function createSegment(p: { name: string; description?: string; type: "static" | "dynamic" | "realtime"; purpose: string; rules: Rule; refresh?: string; aiGenerated?: boolean }, actor: Actor) {
  RuleSchema.parse(p.rules);
  const sid = id("seg");
  const t = nowIso();
  tx(() => {
    run("INSERT INTO segments (id, org_id, name, description, segment_type, purpose, rules, version, status, refresh_schedule, created_by, created_at, updated_at, ai_generated) VALUES (?,?,?,?,?,?,?,1,'active',?,?,?,?,?)",
      sid, ORG_ID, p.name, p.description ?? null, p.type, p.purpose, J.str(p.rules), p.refresh ?? (p.type === "static" ? null : "hourly"), actor.id, t, t, p.aiGenerated ? 1 : 0);
    run("INSERT INTO segment_versions (segment_id, version, rules, created_by, created_at) VALUES (?,?,?,?,?)", sid, 1, J.str(p.rules), actor.id, t);
  });
  audit(actor, "segment.created", "segment", sid, { name: p.name, type: p.type });
  evaluateSegment(sid, actor);
  return one<SegmentRow>("SELECT * FROM segments WHERE id = ?", sid)!;
}

export function updateSegmentRules(segmentId: string, rules: Rule, actor: Actor) {
  RuleSchema.parse(rules);
  const s = one<SegmentRow>("SELECT * FROM segments WHERE id = ?", segmentId);
  if (!s) throw new HttpError(404, "Segment not found");
  const v = s.version + 1;
  tx(() => {
    run("UPDATE segments SET rules = ?, version = ?, updated_at = ? WHERE id = ?", J.str(rules), v, nowIso(), segmentId);
    run("INSERT INTO segment_versions (segment_id, version, rules, created_by, created_at) VALUES (?,?,?,?,?)", segmentId, v, J.str(rules), actor.id, nowIso());
  });
  audit(actor, "segment.updated", "segment", segmentId, { version: v });
  return evaluateSegment(segmentId, actor);
}

/** Full (re)evaluation with membership diff → entry/exit history + downstream events. Static segments are frozen after creation. */
export function evaluateSegment(segmentId: string, actor: Actor = SYSTEM, reason = "scheduled_refresh") {
  const s = one<SegmentRow>("SELECT * FROM segments WHERE id = ?", segmentId);
  if (!s) throw new HttpError(404, "Segment not found");
  const existing = new Set(all<{ player_id: string }>("SELECT player_id FROM segment_memberships WHERE segment_id = ?", segmentId).map((r) => r.player_id));
  if (s.segment_type === "static" && s.last_evaluated_at) return { entered: [], exited: [], size: existing.size };
  const matched = new Set(matchIds(J.parse<Rule>(s.rules, { type: "group", op: "and", children: [] }), undefined, s.purpose));
  const entered = [...matched].filter((p) => !existing.has(p));
  const exited = [...existing].filter((p) => !matched.has(p));
  applyDiff(s, entered, exited, reason);
  run("UPDATE segments SET member_count = ?, last_evaluated_at = ? WHERE id = ?", matched.size, nowIso(), segmentId);
  if (entered.length || exited.length) audit(actor, "segment.evaluated", "segment", segmentId, { entered: entered.length, exited: exited.length, size: matched.size });
  return { entered, exited, size: matched.size };
}

function applyDiff(s: SegmentRow, entered: string[], exited: string[], reason: string) {
  const t = nowIso();
  const ins = db().prepare("INSERT OR IGNORE INTO segment_memberships (segment_id, player_id, joined_at) VALUES (?,?,?)");
  const del = db().prepare("DELETE FROM segment_memberships WHERE segment_id = ? AND player_id = ?");
  const hist = db().prepare("INSERT INTO segment_membership_history (segment_id, player_id, action, reason, at) VALUES (?,?,?,?,?)");
  tx(() => {
    for (const p of entered) { ins.run(s.id, p, t); hist.run(s.id, p, "enter", reason, t); }
    for (const p of exited) { del.run(s.id, p); hist.run(s.id, p, "exit", reason, t); }
  });
  if (entered.length || exited.length) {
    publish("segments", "segment.membership_changed", { segment_id: s.id, name: s.name, entered: entered.length, exited: exited.length, sample_entered: entered.slice(0, 5), sample_exited: exited.slice(0, 5) }, s.id);
  }
  // downstream: journeys listening to segment entry/exit
  if (entered.length || exited.length) {
    import("./journeys").then((j) => j.onSegmentChange(s.id, entered, exited)).catch((e) => console.error("journey trigger failed", e));
  }
}

/** Incremental: re-evaluate dynamic/realtime segments for one player after an event/attribute change. */
export function evaluatePlayer(playerId: string, reason: string) {
  const segs = all<SegmentRow>("SELECT * FROM segments WHERE status = 'active' AND segment_type IN ('dynamic','realtime') ORDER BY id");
  const changes: Array<{ segment_id: string; action: "enter" | "exit" }> = [];
  const memberOf = new Set(all<{ segment_id: string }>("SELECT segment_id FROM segment_memberships WHERE player_id = ?", playerId).map((r) => r.segment_id));
  for (const s of segs) {
    const matches = matchIds(J.parse<Rule>(s.rules, { type: "group", op: "and", children: [] }), playerId, s.purpose).length > 0;
    let changed = false;
    if (matches && !memberOf.has(s.id)) { applyDiff(s, [playerId], [], reason); changes.push({ segment_id: s.id, action: "enter" }); changed = true; }
    if (!matches && memberOf.has(s.id)) { applyDiff(s, [], [playerId], reason); changes.push({ segment_id: s.id, action: "exit" }); changed = true; }
    if (changed) run("UPDATE segments SET member_count = (SELECT COUNT(*) FROM segment_memberships WHERE segment_id = ?) WHERE id = ?", s.id, s.id);
  }
  return changes;
}

export function overlap(ids: string[]) {
  const out: Array<{ a: string; b: string; overlap: number }> = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const n = (db().prepare("SELECT COUNT(*) FROM segment_memberships a JOIN segment_memberships b ON a.player_id = b.player_id WHERE a.segment_id = ? AND b.segment_id = ?").raw().get(ids[i], ids[j]) as number[])[0];
    out.push({ a: ids[i], b: ids[j], overlap: n });
  }
  return out;
}

export function describeRule(r: Rule): string {
  switch (r.type) {
    case "group": return `${r.negate ? "NOT " : ""}(${r.children.map(describeRule).join(` ${r.op.toUpperCase()} `)})`;
    case "attr": return `${FIELDS[r.field]?.label ?? r.field} ${r.op} ${r.value === undefined ? "" : JSON.stringify(r.value)}`.trim();
    case "event": return `${r.event} ${r.op} ${r.count} in last ${r.within_days}d${r.provider_id ? ` (provider ${r.provider_id})` : ""}`;
    case "tag": return `${r.has ? "has" : "lacks"} tag ${r.tag}`;
    case "segment": return `${r.in ? "in" : "not in"} segment ${r.segment_id}`;
    case "attr_change": return `${r.field} changed to ${r.to} in last ${r.within_days}d`;
  }
}
