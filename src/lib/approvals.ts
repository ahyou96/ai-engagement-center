import { all, db, J, one, run } from "./db";
import { audit, Actor } from "./audit";
import { HttpError, id, nowIso, ORG_ID } from "./util";
import { notify, publish } from "./stream";

export type Approval = {
  id: string; entity_type: string; entity_id: string; title: string; summary: string | null; evidence: string; risk: string;
  status: string; required_levels: number; current_level: number; requested_by: string; expires_at: string | null; created_at: string; decided_at: string | null;
};

export function createApproval(p: { entityType: string; entityId: string; title: string; summary: string; evidence?: unknown[]; risk: "low" | "medium" | "high" | "critical"; requestedBy: string; expiresHours?: number }) {
  const existing = one<Approval>("SELECT * FROM approvals WHERE entity_type = ? AND entity_id = ? AND status = 'pending'", p.entityType, p.entityId);
  if (existing) return existing;
  const aid = id("apr");
  const levels = p.risk === "high" || p.risk === "critical" ? 2 : 1;
  const expires = new Date(Date.now() + (p.expiresHours ?? 72) * 3600_000).toISOString();
  run("INSERT INTO approvals (id, org_id, entity_type, entity_id, title, summary, evidence, risk, status, required_levels, current_level, requested_by, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    aid, ORG_ID, p.entityType, p.entityId, p.title, p.summary, J.str(p.evidence ?? []), p.risk, "pending", levels, 1, p.requestedBy, expires, nowIso());
  run("INSERT INTO approval_history (approval_id, level, action, actor, comment, at) VALUES (?,?,?,?,?,?)", aid, 0, "requested", p.requestedBy, p.summary, nowIso());
  audit({ type: p.requestedBy.startsWith("agent:") ? "agent" : "user", id: p.requestedBy }, "approval.requested", p.entityType, p.entityId, { approval_id: aid, risk: p.risk, levels });
  publish("approvals", "approval.created", { id: aid, title: p.title, risk: p.risk, entity_type: p.entityType }, aid);
  notify("approval", "Approval required", p.title, `/compliance?tab=approvals&id=${aid}`, p.risk === "high" || p.risk === "critical" ? "warning" : "info");
  return one<Approval>("SELECT * FROM approvals WHERE id = ?", aid)!;
}

export function expireApprovals() {
  const now = nowIso();
  const expired = all<Approval>("SELECT * FROM approvals WHERE status = 'pending' AND expires_at < ?", now);
  for (const a of expired) {
    run("UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ?", now, a.id);
    run("INSERT INTO approval_history (approval_id, level, action, actor, comment, at) VALUES (?,?,?,?,?,?)", a.id, a.current_level, "expired", "system", null, now);
  }
}

/**
 * Decide an approval. Multi-level: high/critical risk needs 2 distinct approvers.
 * The requester can never approve their own request.
 */
export async function decide(approvalId: string, actor: Actor, action: "approve" | "reject" | "request_changes", comment?: string) {
  expireApprovals();
  const a = one<Approval>("SELECT * FROM approvals WHERE id = ?", approvalId);
  if (!a) throw new HttpError(404, "Approval not found");
  if (a.status !== "pending") throw new HttpError(409, `Approval is ${a.status}`);
  if (actor.id === a.requested_by) throw new HttpError(403, "Requester cannot decide their own approval (separation of duties)");
  const prior = all<{ actor: string }>("SELECT actor FROM approval_history WHERE approval_id = ? AND action = 'approved'", approvalId);
  if (prior.some((p) => p.actor === actor.id)) throw new HttpError(403, "Each approval level requires a different approver");
  const now = nowIso();
  let status = a.status;
  if (action === "approve") {
    run("INSERT INTO approval_history (approval_id, level, action, actor, comment, at) VALUES (?,?,?,?,?,?)", a.id, a.current_level, "approved", actor.id, comment ?? null, now);
    if (a.current_level < a.required_levels) run("UPDATE approvals SET current_level = current_level + 1 WHERE id = ?", a.id);
    else { status = "approved"; run("UPDATE approvals SET status = 'approved', decided_at = ? WHERE id = ?", now, a.id); }
  } else {
    status = action === "reject" ? "rejected" : "changes_requested";
    run("INSERT INTO approval_history (approval_id, level, action, actor, comment, at) VALUES (?,?,?,?,?,?)", a.id, a.current_level, action === "reject" ? "rejected" : "changes_requested", actor.id, comment ?? null, now);
    run("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?", status, now, a.id);
  }
  audit(actor, `approval.${action}`, a.entity_type, a.entity_id, { approval_id: a.id, level: a.current_level, comment, final_status: status });
  publish("approvals", "approval.updated", { id: a.id, status, entity_type: a.entity_type, entity_id: a.entity_id }, a.id);
  if (status === "approved" || status === "rejected" || status === "changes_requested") await dispatch(a, status, actor);
  return one<Approval>("SELECT * FROM approvals WHERE id = ?", a.id)!;
}

async function dispatch(a: Approval, status: string, actor: Actor) {
  switch (a.entity_type) {
    case "strategy_version": return (await import("./strategy")).onApprovalDecided(a.entity_id, status, actor);
    case "workflow_decision": return (await import("./workflow/engine")).onDecisionApproval(a.entity_id, status, actor);
    case "campaign": return (await import("./campaigns")).onApprovalDecided(a.entity_id, status, actor);
    case "journey_version": return (await import("./journeys")).onApprovalDecided(a.entity_id, status, actor);
    case "offer_batch": return (await import("./offers")).onBatchApproval(a.entity_id, status, actor);
    case "template": return (await import("./messaging")).onTemplateApproval(a.entity_id, status, actor);
  }
}

export function history(approvalId: string) {
  return all("SELECT * FROM approval_history WHERE approval_id = ? ORDER BY id", approvalId);
}
export const _db = db;
