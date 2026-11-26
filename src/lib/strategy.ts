import { all, J, one, run, tx } from "./db";
import { audit, Actor, SYSTEM } from "./audit";
import { createApproval } from "./approvals";
import { HttpError, id, nowIso, ORG_ID } from "./util";
import { notify, publish } from "./stream";
import { twoProportionTest } from "./stats";

export type StrategyRow = { id: string; name: string; category: string; objective: string; primary_metric: string; metric_direction: string; active_version: number | null };
export type VersionRow = {
  id: string; strategy_id: string; version: number; parent_version: number | null; config: string; status: string;
  baseline_metrics: string | null; candidate_metrics: string | null; experiment_id: string | null; change_summary: string | null;
  risk_assessment: string | null; effective_at: string | null; rollback_version: number | null; approval_id: string | null; created_by: string; created_at: string;
};
export type ActiveStrategy = { strategyId: string; category: string; version: number; config: Record<string, unknown> };

export const DEFAULT_CONFIGS: Record<string, { name: string; objective: string; metric: string; direction: "up" | "down"; config: Record<string, unknown> }> = {
  provider_monitoring: { name: "Gaming Provider Failure Response", objective: "Detect provider launch failures early and keep affected players informed", metric: "early_detection_coverage", direction: "up",
    config: { failure_rate_threshold: 0.12, min_launches: 40, window_hours: 24, notify_affected: true, channel_order: ["inbox", "app_push", "sms"], create_ticket: true, severity_high_rate: 0.25 } },
  kyc_assistance: { name: "KYC Completion Assistance", objective: "Help players finish KYC with clear, non-duplicated service guidance", metric: "kyc_completion_rate", direction: "up",
    config: { reminder_wait_hours: 48, max_reminders: 3, channel_order: ["sms", "email"], exit_on_kyc_complete: true, stalled_after_hours: 24 } },
  membership_entitlements: { name: "Membership Entitlement Rules", objective: "Consistent, budget-safe membership benefits without duplicates", metric: "entitlement_consistency_rate", direction: "up",
    config: { tiers: { none: 0, reduced: 0.5, standard: 1, enhanced: 1.5 }, enhanced_min_tenure_days: 365, enhanced_vip_tiers: ["gold", "platinum"], reduced_when_budget_ratio_below: 0.15, standard_min_tenure_days: 30 } },
  channel_routing: { name: "Channel Delivery Routing", objective: "Reliable delivery at controlled cost via consented fallback channels", metric: "delivery_rate", direction: "up",
    config: { primary: "sms", fallbacks: ["inbox"], min_delivery_rate: 0.9, max_cost_per_message: 0.6, evaluation_window_hours: 24 } },
  rg_protection: { name: "Responsible Gaming Protection", objective: "Immediately stop promotional activity and offer protective support", metric: "protection_latency_minutes", direction: "down",
    config: { cancel_pending_promotions: true, create_protective_task: true, protective_message: false, remove_from_promotional_segments: true } },
};

export function getStrategy(category: string) {
  return one<StrategyRow>("SELECT * FROM strategies WHERE category = ?", category);
}

/** Every new execution calls this — the latest approved+active version is used, never a hardcoded default. */
export function getActiveStrategy(category: string): ActiveStrategy {
  const s = getStrategy(category);
  if (!s || s.active_version == null) throw new HttpError(409, `No active strategy for category ${category}`);
  const v = one<VersionRow>("SELECT * FROM strategy_versions WHERE strategy_id = ? AND version = ? AND status = 'active'", s.id, s.active_version);
  if (!v) throw new HttpError(409, `Active version ${s.active_version} of ${category} is not in Active status`);
  return { strategyId: s.id, category, version: v.version, config: J.parse(v.config, {}) };
}

export function getVersion(strategyId: string, version: number) {
  const v = one<VersionRow>("SELECT * FROM strategy_versions WHERE strategy_id = ? AND version = ?", strategyId, version);
  return v ? { ...v, config: J.parse<Record<string, unknown>>(v.config, {}) } : undefined;
}

export function optimizerSettings() {
  const def = { auto_optimization: true, evaluation_frequency_hours: 24, min_sample: 200, min_improvement: 0.02, confidence: 0.95, max_deterioration: 0.01, risk_threshold: "medium", approval_mode: "manual", auto_rollback: true, experiment_allocation: 0.2 };
  return { ...def, ...J.parse<Record<string, unknown>>(one<{ value: string }>("SELECT value FROM settings WHERE key = 'optimizer'")?.value, {}) } as typeof def;
}

export function createCandidate(p: { category: string; config: Record<string, unknown>; summary: string; createdBy: string; risk?: string; baseline?: unknown; candidateMetrics?: unknown }) {
  const s = getStrategy(p.category);
  if (!s) throw new HttpError(404, "Strategy not found");
  const maxV = one<{ v: number }>("SELECT MAX(version) v FROM strategy_versions WHERE strategy_id = ?", s.id)?.v ?? 0;
  const vid = id("stv");
  run(`INSERT INTO strategy_versions (id, strategy_id, version, parent_version, config, status, baseline_metrics, candidate_metrics, change_summary, risk_assessment, rollback_version, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, vid, s.id, maxV + 1, s.active_version, J.str(p.config), "candidate", J.str(p.baseline ?? null), J.str(p.candidateMetrics ?? null), p.summary, p.risk ?? "low", s.active_version, p.createdBy, nowIso());
  audit({ type: p.createdBy.startsWith("agent:") ? "agent" : "user", id: p.createdBy }, "strategy.candidate_created", "strategy", s.id, { version: maxV + 1, summary: p.summary });
  publish("strategies", "strategy.candidate", { strategy_id: s.id, category: p.category, version: maxV + 1, summary: p.summary }, s.id);
  return getVersion(s.id, maxV + 1)!;
}

/**
 * Historical validation + controlled experiment evaluation.
 * Baseline = evaluations recorded for the active version; candidate = replay/experiment metrics.
 * Uses a two-proportion z-test; never claims improvement without passing the configured thresholds.
 */
export function evaluateCandidate(strategyId: string, version: number, sample: { baseline: { n: number; s: number }; candidate: { n: number; s: number } }, actor: Actor) {
  const st = optimizerSettings();
  const s = one<StrategyRow>("SELECT * FROM strategies WHERE id = ?", strategyId)!;
  const dir = s.metric_direction === "down" ? -1 : 1;
  const t = twoProportionTest(sample.baseline.s, sample.baseline.n, sample.candidate.s, sample.candidate.n);
  const improvement = t.diff * dir;
  const enoughSample = sample.baseline.n >= st.min_sample && sample.candidate.n >= st.min_sample;
  const significant = t.pValue <= 1 - st.confidence;
  let verdict: "promote" | "insufficient_evidence" | "no_improvement" | "deterioration";
  if (!enoughSample) verdict = "insufficient_evidence";
  else if (improvement < -st.max_deterioration && significant) verdict = "deterioration";
  else if (improvement >= st.min_improvement && significant) verdict = "promote";
  else if (!significant) verdict = "insufficient_evidence";
  else verdict = "no_improvement";
  const expId = id("exp");
  tx(() => {
    run("INSERT INTO experiments (id, strategy_id, name, control_version, candidate_version, allocation, metric, status, started_at, ended_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      expId, strategyId, `v${s.active_version} vs v${version}`, s.active_version, version, st.experiment_allocation, s.primary_metric, "completed", nowIso(), nowIso());
    const ins = "INSERT INTO experiment_results (experiment_id, variant, sample_size, successes, rate, ci_low, ci_high, p_value) VALUES (?,?,?,?,?,?,?,?)";
    run(ins, expId, "control", sample.baseline.n, sample.baseline.s, t.p1, null, null, null);
    run(ins, expId, "candidate", sample.candidate.n, sample.candidate.s, t.p2, t.ciLow, t.ciHigh, t.pValue);
    run("UPDATE strategy_versions SET experiment_id = ?, status = ?, candidate_metrics = ?, baseline_metrics = ? WHERE strategy_id = ? AND version = ?",
      expId, verdict === "promote" ? "pending_approval" : verdict === "deterioration" ? "rejected" : "testing",
      J.str({ rate: t.p2, n: sample.candidate.n }), J.str({ rate: t.p1, n: sample.baseline.n }), strategyId, version);
    run("INSERT INTO strategy_evaluations (id, strategy_id, version, metrics, verdict, notes, at) VALUES (?,?,?,?,?,?,?)", id("sev"), strategyId, version, J.str({ ...t, enoughSample, significant, improvement }), verdict,
      verdict === "promote" ? "Statistically significant improvement over control" : verdict === "insufficient_evidence" ? "Not enough evidence to claim improvement" : verdict === "deterioration" ? "Candidate performed worse — rejected" : "Change below minimum meaningful improvement", nowIso());
  });
  audit(actor, "strategy.evaluated", "strategy", strategyId, { version, verdict, p_value: t.pValue, diff: t.diff });
  publish("strategies", "strategy.evaluated", { strategy_id: strategyId, version, verdict, ...t }, strategyId);
  return { verdict, test: t, experimentId: expId, enoughSample, significant };
}

/** Send to approval, or auto-approve when authorized automatic approval mode allows low-risk changes. */
export function submitForApproval(strategyId: string, version: number, requestedBy: string) {
  const v = getVersion(strategyId, version);
  if (!v) throw new HttpError(404, "Version not found");
  if (!["pending_approval", "candidate", "testing"].includes(v.status)) throw new HttpError(409, `Version is ${v.status}`);
  const st = optimizerSettings();
  const s = one<StrategyRow>("SELECT * FROM strategies WHERE id = ?", strategyId)!;
  const lowRisk = (v.risk_assessment ?? "low") === "low";
  if (st.approval_mode === "auto" && lowRisk && v.status === "pending_approval") {
    run("UPDATE strategy_versions SET status = 'approved' WHERE id = ?", v.id);
    audit({ type: "system", id: "policy-engine" }, "strategy.auto_approved", "strategy", strategyId, { version, reason: "authorized automatic approval: low risk + significant improvement" });
    activate(strategyId, version, { type: "system", id: "policy-engine" });
    return { autoApproved: true };
  }
  run("UPDATE strategy_versions SET status = 'pending_approval' WHERE id = ?", v.id);
  const a = createApproval({ entityType: "strategy_version", entityId: v.id, title: `Activate ${s.name} v${version}`, summary: v.change_summary ?? "", evidence: [{ baseline: J.parse(v.baseline_metrics, null), candidate: J.parse(v.candidate_metrics, null), experiment: v.experiment_id }], risk: (v.risk_assessment as "low") ?? "low", requestedBy });
  run("UPDATE strategy_versions SET approval_id = ? WHERE id = ?", a.id, v.id);
  return { autoApproved: false, approvalId: a.id };
}

export function onApprovalDecided(versionId: string, status: string, actor: Actor) {
  const v = one<VersionRow>("SELECT * FROM strategy_versions WHERE id = ?", versionId);
  if (!v) return;
  if (status === "approved") { run("UPDATE strategy_versions SET status = 'approved' WHERE id = ?", versionId); activate(v.strategy_id, v.version, actor); }
  else run("UPDATE strategy_versions SET status = ? WHERE id = ?", status === "rejected" ? "rejected" : "candidate", versionId);
}

export function activate(strategyId: string, version: number, actor: Actor) {
  const v = getVersion(strategyId, version);
  if (!v) throw new HttpError(404, "Version not found");
  if (!["approved", "paused", "archived", "rolled_back"].includes(v.status) && v.status !== "active") throw new HttpError(409, `Only approved versions can be activated (status: ${v.status})`);
  const s = one<StrategyRow>("SELECT * FROM strategies WHERE id = ?", strategyId)!;
  tx(() => {
    if (s.active_version != null && s.active_version !== version) run("UPDATE strategy_versions SET status = 'archived' WHERE strategy_id = ? AND version = ? AND status = 'active'", strategyId, s.active_version);
    run("UPDATE strategy_versions SET status = 'active', effective_at = ?, rollback_version = COALESCE(rollback_version, ?) WHERE strategy_id = ? AND version = ?", nowIso(), s.active_version, strategyId, version);
    run("UPDATE strategies SET active_version = ? WHERE id = ?", version, strategyId);
  });
  audit(actor, "strategy.activated", "strategy", strategyId, { version, previous: s.active_version });
  publish("strategies", "strategy.activated", { strategy_id: strategyId, category: s.category, version, previous: s.active_version }, strategyId);
  notify("strategy", "Strategy activated", `${s.name} v${version} is now active; new executions will use it.`, `/optimizer?strategy=${strategyId}`, "success");
}

export function rollback(strategyId: string, actor: Actor, reason = "manual rollback") {
  const s = one<StrategyRow>("SELECT * FROM strategies WHERE id = ?", strategyId);
  if (!s || s.active_version == null) throw new HttpError(404, "No active version");
  const cur = getVersion(strategyId, s.active_version)!;
  const target = cur.rollback_version ?? cur.parent_version;
  if (target == null) throw new HttpError(409, "No rollback version available");
  tx(() => {
    run("UPDATE strategy_versions SET status = 'rolled_back' WHERE strategy_id = ? AND version = ?", strategyId, cur.version);
    run("UPDATE strategy_versions SET status = 'active', effective_at = ? WHERE strategy_id = ? AND version = ?", nowIso(), strategyId, target);
    run("UPDATE strategies SET active_version = ? WHERE id = ?", target, strategyId);
  });
  audit(actor, "strategy.rolled_back", "strategy", strategyId, { from: cur.version, to: target, reason });
  publish("strategies", "strategy.rolled_back", { strategy_id: strategyId, from: cur.version, to: target, reason }, strategyId);
  notify("strategy", "Strategy rolled back", `${s.name}: v${cur.version} → v${target} (${reason})`, `/optimizer?strategy=${strategyId}`, "warning");
  return { from: cur.version, to: target };
}

export function setStatus(strategyId: string, version: number, status: "paused" | "archived", actor: Actor) {
  run("UPDATE strategy_versions SET status = ? WHERE strategy_id = ? AND version = ?", status, strategyId, version);
  audit(actor, `strategy.${status}`, "strategy", strategyId, { version });
}

export function listStrategies() {
  return all<StrategyRow & { versions: number; pending: number }>(`SELECT s.*, (SELECT COUNT(*) FROM strategy_versions v WHERE v.strategy_id = s.id) versions,
    (SELECT COUNT(*) FROM strategy_versions v WHERE v.strategy_id = s.id AND v.status IN ('candidate','testing','pending_approval')) pending FROM strategies s ORDER BY s.name`);
}

export function recordExecutionResult(strategyId: string, version: number, runId: string, metrics: Record<string, unknown>) {
  run("INSERT INTO strategy_evaluations (id, strategy_id, version, run_id, metrics, verdict, notes, at) VALUES (?,?,?,?,?,?,?,?)", id("sev"), strategyId, version, runId, J.str(metrics), "observed", "Execution result collected", nowIso());
}
export { SYSTEM, ORG_ID };
