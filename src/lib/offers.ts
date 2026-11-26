import { all, db, J, one, run, tx } from "./db";
import { audit, Actor } from "./audit";
import { evaluate, Purpose } from "./compliance";
import { getActiveStrategy } from "./strategy";
import { createApproval } from "./approvals";
import { HttpError, id, nowDate, nowIso, ORG_ID, round } from "./util";
import { publish } from "./stream";

/**
 * Deterministic entitlement decision engine.
 * Inputs it is ALLOWED to use: membership tier, tenure, KYC, documented service impact (e.g. launch failures),
 * budget, existing entitlements, compliance status, approved strategy config.
 * Inputs it NEVER reads: deposits, losses, wagering, session intensity, predicted propensity, vulnerability signals.
 */
export const OFFER_CATEGORIES = ["membership_benefit", "service_compensation", "contractual", "regulated_promotion"] as const;
export type Outcome = "none" | "reduced" | "standard" | "enhanced";
export type Offer = { id: string; name: string; category: string; base_amount: number; unit: string; eligibility: string; validity_days: number; per_user_limit: number; distribution_limit: number | null; status: string; version: number; requires_approval: number; allow_personalization: number; description: string | null };
type Cust = { player_id: string; vip_tier: string; registered_at: string; kyc_status: string; launch_failures_7d: number; primary_platform: string; age: number | null; account_status: string };
export type Decision = { player_id: string; offer_id: string; outcome: Outcome; base_amount: number; approved_amount: number; rules: string[]; reason: string; budget: { ok: boolean; remaining: number; ratio: number; note?: string }; compliance: { ok: boolean; reasons: string[] } };

const purposeOf = (category: string): Purpose => (category === "regulated_promotion" ? "regulated_promotion" : category === "membership_benefit" ? "membership" : "service");

export function budgetFor(offerId: string) {
  return one<{ id: string; total: number; reserved: number; spent: number; daily_limit: number | null; period_end: string; name: string }>(
    "SELECT * FROM offer_budgets WHERE (offer_id = ? OR scope = 'total') AND period_end > ? ORDER BY CASE WHEN offer_id = ? THEN 0 ELSE 1 END LIMIT 1", offerId, nowIso(), offerId);
}

export function decideForPlayers(offerId: string, playerIds: string[], opts: { config?: Record<string, unknown> } = {}): { decisions: Decision[]; strategy: { id: string; version: number } } {
  const offer = one<Offer>("SELECT * FROM offers WHERE id = ?", offerId);
  if (!offer) throw new HttpError(404, "Offer not found");
  const strat = getActiveStrategy("membership_entitlements");
  const cfg = { ...strat.config, ...(opts.config ?? {}) } as { tiers: Record<Outcome, number>; enhanced_min_tenure_days: number; enhanced_vip_tiers: string[]; reduced_when_budget_ratio_below: number; standard_min_tenure_days: number };
  const elig = J.parse<{ min_tenure_days?: number; kyc_required?: boolean; vip_tiers?: string[]; platforms?: string[]; min_launch_failures_7d?: number }>(offer.eligibility, {});
  const budget = budgetFor(offerId);
  let remaining = budget ? budget.total - budget.reserved - budget.spent : Infinity;
  const total = budget?.total ?? Infinity;
  const purpose = purposeOf(offer.category);
  const comp = new Map(evaluate({ playerIds, purpose, action: "offer", context: "offer_decision", refId: offerId }).map((c) => [c.player_id, c]));
  const existing = new Map(all<{ player_id: string; n: number }>(`SELECT player_id, COUNT(*) n FROM offer_transactions WHERE offer_id = ? AND status NOT IN ('cancelled','reversed','expired') AND player_id IN (${playerIds.map(() => "?").join(",") || "''"}) GROUP BY player_id`, offerId, ...playerIds).map((r) => [r.player_id, r.n]));
  const custs = new Map(all<Cust>(`SELECT player_id, vip_tier, registered_at, kyc_status, launch_failures_7d, primary_platform, age, account_status FROM customers WHERE player_id IN (${playerIds.map(() => "?").join(",") || "''"})`, ...playerIds).map((c) => [c.player_id, c]));
  const now = nowDate().getTime();
  const decisions: Decision[] = [];
  for (const pid of playerIds) {
    const c = custs.get(pid);
    const rules: string[] = [];
    const mk = (outcome: Outcome, reason: string, extra: Partial<Decision> = {}): Decision => {
      const amt = round(offer.base_amount * (cfg.tiers?.[outcome] ?? (outcome === "none" ? 0 : 1)));
      return { player_id: pid, offer_id: offerId, outcome, base_amount: offer.base_amount, approved_amount: outcome === "none" ? 0 : amt, rules, reason, budget: { ok: true, remaining, ratio: total === Infinity ? 1 : remaining / total }, compliance: { ok: true, reasons: [] }, ...extra };
    };
    if (!c) { decisions.push(mk("none", "Player not found")); continue; }
    const cc = comp.get(pid)!;
    if (!cc.allowed) { rules.push("compliance"); decisions.push(mk("none", "Blocked by compliance", { compliance: { ok: false, reasons: cc.reasons.map((r) => r.message) } })); continue; }
    // entitlements are incentives — excluded players never receive them, whatever the category
    const ex = one<{ n: number }>("SELECT COUNT(*) n FROM exclusion_records WHERE player_id = ? AND active = 1 AND exclusion_type IN ('self_exclusion','rg_restriction','account_restriction')", pid)!.n;
    if (ex) { rules.push("exclusion"); decisions.push(mk("none", "Active exclusion — route to protective service team instead", { compliance: { ok: false, reasons: ["active exclusion"] } })); continue; }
    if (offer.status !== "active") { rules.push("offer_status"); decisions.push(mk("none", `Offer is ${offer.status}`)); continue; }
    if ((existing.get(pid) ?? 0) >= offer.per_user_limit) { rules.push("duplicate_prevention"); decisions.push(mk("none", `Already holds ${existing.get(pid)} of max ${offer.per_user_limit}`)); continue; }
    const tenure = (now - new Date(c.registered_at).getTime()) / 86400_000;
    if (elig.kyc_required && c.kyc_status !== "verified") { rules.push("eligibility.kyc"); decisions.push(mk("none", "KYC not verified")); continue; }
    if (elig.min_tenure_days && tenure < elig.min_tenure_days) { rules.push("eligibility.tenure"); decisions.push(mk("none", `Tenure ${Math.floor(tenure)}d < ${elig.min_tenure_days}d`)); continue; }
    if (elig.vip_tiers?.length && !elig.vip_tiers.includes(c.vip_tier)) { rules.push("eligibility.tier"); decisions.push(mk("none", `Tier ${c.vip_tier} not eligible`)); continue; }
    if (elig.platforms?.length && !elig.platforms.includes(c.primary_platform)) { rules.push("eligibility.platform"); decisions.push(mk("none", `Platform ${c.primary_platform} not eligible`)); continue; }

    let outcome: Outcome; let reason: string;
    switch (offer.category) {
      case "service_compensation": {
        const f = c.launch_failures_7d;
        const min = elig.min_launch_failures_7d ?? 1;
        if (f < min) { outcome = "none"; reason = `Not affected (launch failures ${f} < ${min})`; }
        else if (f >= 10) { outcome = "enhanced"; reason = `Severe documented service impact (${f} failed launches)`; }
        else if (f >= 3) { outcome = "standard"; reason = `Documented service impact (${f} failed launches)`; }
        else { outcome = "reduced"; reason = `Minor documented service impact (${f} failed launch${f > 1 ? "es" : ""})`; }
        rules.push("tier.service_impact");
        break;
      }
      case "contractual": outcome = "standard"; reason = "Contractual entitlement — fixed amount"; rules.push("tier.contractual_fixed"); break;
      case "regulated_promotion": outcome = "standard"; reason = "Regulated promotion — uniform amount, no personalization"; rules.push("tier.no_personalization"); break;
      default: {
        if (!offer.allow_personalization) { outcome = "standard"; reason = "Personalization disabled for this offer"; }
        else if (cfg.enhanced_vip_tiers?.includes(c.vip_tier) && tenure >= cfg.enhanced_min_tenure_days) { outcome = "enhanced"; reason = `${c.vip_tier} tier with ${Math.floor(tenure)}d tenure`; }
        else if (tenure >= cfg.standard_min_tenure_days) { outcome = "standard"; reason = `Tenure ${Math.floor(tenure)}d ≥ ${cfg.standard_min_tenure_days}d`; }
        else { outcome = "reduced"; reason = `New member (tenure ${Math.floor(tenure)}d)`; }
        rules.push("tier.membership_tenure");
      }
    }
    if (outcome !== "none") {
      const ratio = total === Infinity ? 1 : remaining / total;
      if (ratio < cfg.reduced_when_budget_ratio_below && (outcome === "enhanced" || outcome === "standard") && offer.category !== "contractual") { outcome = "reduced"; reason += "; downgraded — budget below threshold"; rules.push("budget.downgrade"); }
      const amt = round(offer.base_amount * (cfg.tiers?.[outcome] ?? 1));
      if (amt > remaining) { rules.push("budget.exhausted"); decisions.push(mk("none", "Insufficient budget", { budget: { ok: false, remaining, ratio, note: "exhausted" } })); continue; }
      remaining -= amt;
    }
    decisions.push(mk(outcome, reason));
  }
  return { decisions, strategy: { id: strat.strategyId, version: strat.version } };
}

/** Evaluate + persist a decision batch. Non-simulated batches go to approval (if required) before issuance. */
export function runBatch(offerId: string, playerIds: string[], opts: { simulate: boolean; actor: Actor; config?: Record<string, unknown>; preApproved?: boolean }) {
  const { decisions, strategy } = decideForPlayers(offerId, playerIds, { config: opts.config });
  const offer = one<Offer>("SELECT * FROM offers WHERE id = ?", offerId)!;
  const batchId = id("ob");
  const t = nowIso();
  const approvalStatus = opts.simulate ? "simulated" : opts.preApproved ? "approved_via_workflow" : offer.requires_approval ? "pending" : "auto_approved";
  const ins = db().prepare(`INSERT INTO offer_decisions (id, batch_id, player_id, offer_id, outcome, base_amount, approved_amount, rules_applied, reason, budget_check, compliance_check, strategy_id, strategy_version, approval_status, simulated, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  tx(() => { for (const d of decisions) ins.run(id("odc"), batchId, d.player_id, offerId, d.outcome, d.base_amount, d.approved_amount, J.str(d.rules), d.reason, J.str(d.budget), J.str(d.compliance), strategy.id, strategy.version, approvalStatus, opts.simulate ? 1 : 0, t); });
  const summary = summarizeDecisions(decisions);
  audit(opts.actor, opts.simulate ? "offer.simulated" : "offer.batch_evaluated", "offer", offerId, { batch_id: batchId, ...summary, strategy_version: strategy.version });
  let approvalId: string | undefined; let issued: ReturnType<typeof issueBatch> | undefined;
  if (!opts.simulate) {
    if (offer.requires_approval && !opts.preApproved) {
      approvalId = createApproval({ entityType: "offer_batch", entityId: batchId, title: `Issue ${offer.name} to ${summary.eligible} players (${offer.unit} ${summary.total_amount})`, summary: `Decision distribution: ${JSON.stringify(summary.distribution)}`, evidence: [summary], risk: summary.total_amount > 50000 ? "high" : "medium", requestedBy: opts.actor.id }).id;
    } else issued = issueBatch(batchId, opts.actor);
  }
  return { batchId, decisions, summary, strategy, approvalId, issued };
}

export function summarizeDecisions(ds: Decision[]) {
  const distribution: Record<Outcome, number> = { none: 0, reduced: 0, standard: 0, enhanced: 0 };
  let total = 0;
  const reasons: Record<string, number> = {};
  for (const d of ds) { distribution[d.outcome]++; total += d.approved_amount; if (d.outcome === "none") { const k = d.reason.split(" (")[0].split(" —")[0]; reasons[k] = (reasons[k] ?? 0) + 1; } }
  return { evaluated: ds.length, eligible: ds.length - distribution.none, distribution, total_amount: round(total), none_reasons: reasons };
}

export function onBatchApproval(batchId: string, status: string, actor: Actor) {
  if (status === "approved") { run("UPDATE offer_decisions SET approval_status = 'approved' WHERE batch_id = ?", batchId); issueBatch(batchId, actor); }
  else run("UPDATE offer_decisions SET approval_status = ? WHERE batch_id = ?", status, batchId);
}

/** Idempotent issuance with atomic budget reservation. Re-running the same batch never double-issues. */
export function issueBatch(batchId: string, actor: Actor) {
  const ds = all<{ id: string; player_id: string; offer_id: string; outcome: string; approved_amount: number }>("SELECT * FROM offer_decisions WHERE batch_id = ? AND outcome != 'none' AND simulated = 0", batchId);
  let issued = 0, duplicates = 0, budgetBlocked = 0, complianceBlocked = 0;
  for (const d of ds) {
    const r = issueOne(d.offer_id, d.player_id, d.approved_amount, `batch:${batchId}:${d.player_id}`, d.id, actor);
    if (r.status === "issued") issued++; else if (r.status === "duplicate") duplicates++; else if (r.status === "budget") budgetBlocked++; else complianceBlocked++;
  }
  run("UPDATE offer_decisions SET approval_status = 'issued' WHERE batch_id = ? AND outcome != 'none'", batchId);
  audit(actor, "offer.issued", "offer_batch", batchId, { issued, duplicates, budgetBlocked, complianceBlocked, simulated: true });
  publish("offers", "offers.issued", { batch_id: batchId, issued, duplicates, budgetBlocked, complianceBlocked }, batchId);
  return { issued, duplicates, budgetBlocked, complianceBlocked };
}

export function issueOne(offerId: string, playerId: string, amount: number, idemKey: string, decisionId: string | null, actor: Actor): { status: "issued" | "duplicate" | "budget" | "compliance"; txId?: string } {
  const offer = one<Offer>("SELECT * FROM offers WHERE id = ?", offerId)!;
  // compliance re-checked at execution time (state may have changed since the decision)
  const c = evaluate({ playerIds: [playerId], purpose: purposeOf(offer.category), action: "offer", context: "offer_issue", refId: offerId, log: false })[0];
  const ex = one<{ n: number }>("SELECT COUNT(*) n FROM exclusion_records WHERE player_id = ? AND active = 1 AND exclusion_type IN ('self_exclusion','rg_restriction','account_restriction')", playerId)!.n;
  if (!c.allowed || ex) return { status: "compliance" };
  return tx(() => {
    if (one("SELECT 1 FROM offer_transactions WHERE idempotency_key = ?", idemKey)) { logDup(idemKey, playerId); return { status: "duplicate" as const }; }
    const held = one<{ n: number }>("SELECT COUNT(*) n FROM offer_transactions WHERE offer_id = ? AND player_id = ? AND status NOT IN ('cancelled','reversed','expired')", offerId, playerId)!.n;
    if (held >= offer.per_user_limit) { logDup(idemKey, playerId); return { status: "duplicate" as const }; }
    const b = budgetFor(offerId);
    if (b) {
      const upd = run("UPDATE offer_budgets SET reserved = reserved + ? WHERE id = ? AND total - reserved - spent >= ?", amount, b.id, amount);
      if (upd.changes === 0) return { status: "budget" as const };
    }
    const txId = id("otx");
    const t = nowIso();
    const exp = new Date(nowDate().getTime() + offer.validity_days * 86400_000).toISOString();
    run("INSERT INTO offer_transactions (id, idempotency_key, decision_id, player_id, offer_id, budget_id, amount, status, history, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      txId, idemKey, decisionId, playerId, offerId, b?.id ?? null, amount, "issued", J.str([{ status: "reserved", at: t }, { status: "issued", at: t, by: actor.id }]), exp, t, t);
    return { status: "issued" as const, txId };
  });
}
function logDup(key: string, pid: string) { run("INSERT INTO duplicate_prevention_log (kind, key, player_id, at) VALUES ('offer', ?, ?, ?)", key, pid, nowIso()); }

const TRANSITIONS: Record<string, string[]> = { issued: ["claimed", "expired", "cancelled", "reversed"], claimed: ["redeemed", "expired", "reversed"], redeemed: ["reversed"] };
export function transition(txId: string, to: "claimed" | "redeemed" | "expired" | "cancelled" | "reversed", actor: Actor) {
  return tx(() => {
    const t = one<{ id: string; status: string; amount: number; budget_id: string | null; history: string; player_id: string }>("SELECT * FROM offer_transactions WHERE id = ?", txId);
    if (!t) throw new HttpError(404, "Transaction not found");
    if (!TRANSITIONS[t.status]?.includes(to)) throw new HttpError(409, `Cannot move ${t.status} → ${to}`);
    if (t.budget_id) {
      if (to === "redeemed") run("UPDATE offer_budgets SET reserved = reserved - ?, spent = spent + ? WHERE id = ?", t.amount, t.amount, t.budget_id);
      if (["expired", "cancelled"].includes(to) || (to === "reversed" && t.status !== "redeemed")) run("UPDATE offer_budgets SET reserved = reserved - ? WHERE id = ?", t.amount, t.budget_id);
      if (to === "reversed" && t.status === "redeemed") run("UPDATE offer_budgets SET spent = spent - ? WHERE id = ?", t.amount, t.budget_id);
    }
    const h = J.parse<unknown[]>(t.history, []); h.push({ status: to, at: nowIso(), by: actor.id });
    run("UPDATE offer_transactions SET status = ?, history = ?, updated_at = ? WHERE id = ?", to, J.str(h), nowIso(), txId);
    audit(actor, `offer.${to}`, "offer_transaction", txId, { player_id: t.player_id });
    return { id: txId, status: to };
  });
}

/** Cancel any unclaimed entitlements (e.g. responsible gaming restriction). */
export function cancelOpenEntitlements(playerId: string, actor: Actor) {
  const open = all<{ id: string }>("SELECT id FROM offer_transactions WHERE player_id = ? AND status = 'issued'", playerId);
  for (const o of open) transition(o.id, "cancelled", actor);
  return open.length;
}

export function reconcile() {
  return all(`SELECT b.id, b.name, b.total, b.reserved, b.spent,
    COALESCE((SELECT SUM(amount) FROM offer_transactions t WHERE t.budget_id = b.id AND t.status IN ('issued','claimed')),0) tx_reserved,
    COALESCE((SELECT SUM(amount) FROM offer_transactions t WHERE t.budget_id = b.id AND t.status = 'redeemed'),0) tx_spent
    FROM offer_budgets b`).map((r) => {
    const x = r as { reserved: number; spent: number; tx_reserved: number; tx_spent: number };
    return { ...r, reserved_diff: round(x.reserved - x.tx_reserved), spent_diff: round(x.spent - x.tx_spent), balanced: Math.abs(x.reserved - x.tx_reserved) < 0.01 && Math.abs(x.spent - x.tx_spent) < 0.01 };
  });
}
export const _org = ORG_ID;
