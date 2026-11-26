import { all, J, one, run } from "./db";
import { audit, Actor } from "./audit";
import { evaluate, isPromotional, Purpose, summarize } from "./compliance";
import { sendMessages } from "./messaging";
import { createApproval } from "./approvals";
import { getActiveStrategy } from "./strategy";
import { bucket, HttpError, id, nowIso, ORG_ID } from "./util";
import { publish } from "./stream";

export const OBJECTIVES = {
  service_communication: { purpose: "service", label: "Service communication" },
  account_security: { purpose: "security", label: "Account security" },
  operational_notice: { purpose: "operational", label: "Operational notice" },
  membership_communication: { purpose: "membership", label: "Permitted membership communication" },
  regulated_marketing: { purpose: "marketing", label: "Regulated marketing" },
} as const;

export type Campaign = { id: string; name: string; objective: string; purpose: string; status: string; segment_id: string | null; channels: string; template_id: string | null; offer_id: string | null; schedule_at: string | null; timezone: string; budget: number; ab_test: string | null; approval_id: string | null; version: number; strategy_id: string | null; strategy_version: number | null; stats: string; created_by: string | null; created_at: string; updated_at: string };

export function getCampaign(cid: string) {
  const c = one<Campaign>("SELECT * FROM campaigns WHERE id = ?", cid);
  if (!c) throw new HttpError(404, "Campaign not found");
  return c;
}

export function createCampaign(p: { name: string; objective: keyof typeof OBJECTIVES; segment_id: string; channels: string[]; template_id: string; schedule_at?: string | null; timezone?: string; budget?: number; ab_test?: { variant_b_template_id: string; split: number } | null; offer_id?: string | null }, actor: Actor) {
  const obj = OBJECTIVES[p.objective];
  if (!obj) throw new HttpError(400, "Unknown objective");
  const cid = id("cmp");
  const t = nowIso();
  run(`INSERT INTO campaigns (id, org_id, name, objective, purpose, status, segment_id, channels, template_id, offer_id, schedule_at, timezone, budget, ab_test, version, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`, cid, ORG_ID, p.name, p.objective, obj.purpose, "draft", p.segment_id, J.str(p.channels), p.template_id, p.offer_id ?? null, p.schedule_at ?? null, p.timezone ?? "Asia/Manila", p.budget ?? 0, p.ab_test ? J.str(p.ab_test) : null, actor.id, t, t);
  snapshot(cid, actor);
  audit(actor, "campaign.created", "campaign", cid, { name: p.name, objective: p.objective });
  return getCampaign(cid);
}

export function updateCampaign(cid: string, patch: Partial<{ name: string; segment_id: string; channels: string[]; template_id: string; schedule_at: string | null; budget: number; ab_test: unknown }>, actor: Actor) {
  const c = getCampaign(cid);
  if (!["draft", "changes_requested", "rejected"].includes(c.status)) throw new HttpError(409, `Cannot edit a ${c.status} campaign — duplicate it instead`);
  const fields: string[] = []; const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) { fields.push(`${k} = ?`); vals.push(k === "channels" || k === "ab_test" ? J.str(v) : v); }
  run(`UPDATE campaigns SET ${fields.join(", ")}, version = version + 1, status = 'draft', updated_at = ? WHERE id = ?`, ...vals, nowIso(), cid);
  snapshot(cid, actor);
  audit(actor, "campaign.updated", "campaign", cid, patch);
  return getCampaign(cid);
}
function snapshot(cid: string, actor: Actor) {
  const c = getCampaign(cid);
  run("INSERT OR REPLACE INTO campaign_versions (campaign_id, version, snapshot, created_by, created_at) VALUES (?,?,?,?,?)", cid, c.version, J.str(c), actor.id, nowIso());
}

/** Pre-flight: audience size, consent, frequency, quiet hours, budget, template — no side effects except check log. */
export function validateCampaign(cid: string) {
  const c = getCampaign(cid);
  const issues: Array<{ level: "error" | "warning"; message: string }> = [];
  const members = all<{ player_id: string }>("SELECT player_id FROM segment_memberships WHERE segment_id = ?", c.segment_id).map((r) => r.player_id);
  if (!members.length) issues.push({ level: "error", message: "Audience is empty" });
  const tpl = one<{ status: string; purpose: string; channel: string }>("SELECT status, purpose, channel FROM message_templates WHERE id = ?", c.template_id);
  if (!tpl) issues.push({ level: "error", message: "Template missing" });
  else {
    if (tpl.status !== "approved") issues.push({ level: "error", message: "Template not approved" });
    if (isPromotional(tpl.purpose) !== isPromotional(c.purpose)) issues.push({ level: "error", message: `Template purpose (${tpl.purpose}) does not match campaign purpose (${c.purpose})` });
  }
  const channels = J.parse<string[]>(c.channels, []);
  const perChannel: Record<string, { allowed: number; blocked: number; by_policy: Record<string, number>; est_cost: number }> = {};
  for (const ch of channels) {
    const checks = evaluate({ playerIds: members, purpose: c.purpose as Purpose, channel: ch, action: "message", context: "campaign_preflight", refId: cid, log: false });
    const cost = one<{ cost_per_message: number }>("SELECT cost_per_message FROM channels WHERE key = ?", ch)?.cost_per_message ?? 0;
    const allowed = checks.filter((x) => x.allowed).length;
    perChannel[ch] = { allowed, blocked: checks.length - allowed, by_policy: summarize(checks), est_cost: Math.round(allowed * cost * 100) / 100 };
  }
  const estCost = Object.values(perChannel).reduce((s, x) => s + x.est_cost, 0);
  if (c.budget > 0 && estCost > c.budget) issues.push({ level: "error", message: `Estimated cost ${estCost} exceeds campaign budget ${c.budget}` });
  if (Object.values(perChannel).every((x) => x.allowed === 0) && members.length) issues.push({ level: "error", message: "No reachable players after compliance checks" });
  return { audience: members.length, perChannel, estCost, issues, ok: !issues.some((i) => i.level === "error") };
}

export function submitCampaign(cid: string, actor: Actor) {
  const v = validateCampaign(cid);
  if (!v.ok) throw new HttpError(422, "Campaign failed validation", v.issues);
  const c = getCampaign(cid);
  const risk = isPromotional(c.purpose) ? "medium" : "low";
  const a = createApproval({ entityType: "campaign", entityId: cid, title: `Campaign: ${c.name}`, summary: `${OBJECTIVES[c.objective as keyof typeof OBJECTIVES]?.label} → ${v.audience} players, est. cost ${v.estCost}`, evidence: [v], risk, requestedBy: actor.id });
  run("UPDATE campaigns SET status = 'pending_approval', approval_id = ?, updated_at = ? WHERE id = ?", a.id, nowIso(), cid);
  audit(actor, "campaign.submitted", "campaign", cid, { approval_id: a.id });
  return { approvalId: a.id, validation: v };
}

export function onApprovalDecided(cid: string, status: string, actor: Actor) {
  run("UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?", status === "approved" ? "approved" : status === "rejected" ? "rejected" : "changes_requested", nowIso(), cid);
  audit(actor, `campaign.${status}`, "campaign", cid, {});
}

/** Execute (mock sending). Uses the active channel-routing strategy, pinned to the campaign run. */
export function executeCampaign(cid: string, actor: Actor, opts: { simulate?: boolean } = {}) {
  const c = getCampaign(cid);
  if (!opts.simulate && c.status !== "approved" && c.status !== "paused") throw new HttpError(409, `Campaign must be approved before execution (status: ${c.status})`);
  const routing = getActiveStrategy("channel_routing");
  const members = all<{ player_id: string }>("SELECT player_id FROM segment_memberships WHERE segment_id = ?", c.segment_id).map((r) => r.player_id);
  const ab = J.parse<{ variant_b_template_id?: string; split?: number } | null>(c.ab_test, null);
  const channels = J.parse<string[]>(c.channels, []);
  const totals = { sent: 0, blocked: 0, duplicates: 0, failed: 0, cost: 0, variants: { A: 0, B: 0 } as Record<string, number> };
  const groups: Record<string, string[]> = { A: [], B: [] };
  for (const p of members) (ab?.variant_b_template_id && bucket(`${cid}:${p}`) < (ab.split ?? 0.5) ? groups.B : groups.A).push(p);
  for (const [variant, players] of Object.entries(groups)) {
    if (!players.length) continue;
    let remaining = players;
    for (const ch of channels) {
      if (!remaining.length) break;
      const r = sendMessages({ playerIds: remaining, channel: ch, purpose: c.purpose as Purpose, templateId: variant === "B" ? ab!.variant_b_template_id! : c.template_id!, idempotencyPrefix: `campaign:${cid}:v${c.version}:${variant}`, campaignId: cid, variant, actor, context: "campaign", simulateOnly: opts.simulate });
      totals.sent += r.sent; totals.duplicates += r.duplicates; totals.failed += r.failed; totals.cost += r.cost; totals.variants[variant] += r.sent;
      // players blocked on this channel (e.g. no consent) may be reachable on the next approved channel
      const blockedIds = new Set(r.blockedDetails.length ? evaluate({ playerIds: remaining, purpose: c.purpose as Purpose, channel: ch, action: "message", log: false }).filter((x) => !x.allowed).map((x) => x.player_id) : []);
      remaining = remaining.filter((p) => blockedIds.has(p));
    }
    totals.blocked += remaining.length;
  }
  if (!opts.simulate) {
    run("UPDATE campaigns SET status = 'completed', stats = ?, strategy_id = ?, strategy_version = ?, updated_at = ? WHERE id = ?", J.str({ ...totals, audience: members.length, executed_at: nowIso() }), routing.strategyId, routing.version, nowIso(), cid);
    audit(actor, "campaign.executed", "campaign", cid, { ...totals, simulated_delivery: true });
    publish("campaigns", "campaign.executed", { campaign_id: cid, ...totals }, cid);
  }
  return { audience: members.length, ...totals, simulated: true };
}

export function setCampaignStatus(cid: string, status: "paused" | "cancelled", actor: Actor) {
  const c = getCampaign(cid);
  if (["completed", "cancelled"].includes(c.status)) throw new HttpError(409, `Campaign already ${c.status}`);
  run("UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?", status, nowIso(), cid);
  if (status === "cancelled") run("UPDATE messages SET status = 'cancelled', updated_at = ? WHERE campaign_id = ? AND status = 'queued'", nowIso(), cid);
  audit(actor, `campaign.${status}`, "campaign", cid, {});
}

export function duplicateCampaign(cid: string, actor: Actor) {
  const c = getCampaign(cid);
  const nid = id("cmp"); const t = nowIso();
  run(`INSERT INTO campaigns (id, org_id, name, objective, purpose, status, segment_id, channels, template_id, offer_id, schedule_at, timezone, budget, ab_test, version, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,1,?,?,?)`, nid, ORG_ID, `${c.name} (copy)`, c.objective, c.purpose, c.segment_id, c.channels, c.template_id, c.offer_id, null, c.timezone, c.budget, c.ab_test, actor.id, t, t);
  snapshot(nid, actor);
  audit(actor, "campaign.duplicated", "campaign", nid, { from: cid });
  return getCampaign(nid);
}

export function campaignReport(cid: string) {
  const c = getCampaign(cid);
  const byStatus = all("SELECT status, COUNT(*) n FROM messages WHERE campaign_id = ? GROUP BY status", cid);
  const byVariant = all(`SELECT variant, COUNT(*) sent, SUM(CASE WHEN status IN ('delivered','read','clicked') THEN 1 ELSE 0 END) delivered,
    SUM(CASE WHEN status IN ('read','clicked') THEN 1 ELSE 0 END) read, SUM(CASE WHEN status = 'clicked' THEN 1 ELSE 0 END) clicked FROM messages WHERE campaign_id = ? GROUP BY variant`, cid);
  const byChannel = all("SELECT channel, COUNT(*) n, ROUND(SUM(cost),2) cost FROM messages WHERE campaign_id = ? GROUP BY channel", cid);
  const versions = all("SELECT version, created_by, created_at FROM campaign_versions WHERE campaign_id = ? ORDER BY version DESC", cid);
  return { campaign: c, byStatus, byVariant, byChannel, versions };
}
