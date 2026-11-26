import { db, one, J } from "./db";
import { hashStable, nowIso, ORG_ID } from "./util";

export type Actor = { type: "user" | "agent" | "system" | "api"; id: string };
export const SYSTEM: Actor = { type: "system", id: "system" };

/** Append-only, hash-chained audit record. UPDATE/DELETE are blocked by DB triggers. */
export function audit(actor: Actor, action: string, entityType: string | null, entityId: string | null, details?: unknown) {
  const prev = one<{ hash: string }>("SELECT hash FROM audit_logs ORDER BY seq DESC LIMIT 1")?.hash ?? "GENESIS";
  const at = nowIso();
  const body = J.str(details ?? {});
  const hash = hashStable(`${prev}|${actor.type}|${actor.id}|${action}|${entityType}|${entityId}|${body}|${at}`);
  db().prepare(
    "INSERT INTO audit_logs (org_id, actor_type, actor_id, action, entity_type, entity_id, details, prev_hash, hash, at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run(ORG_ID, actor.type, actor.id, action, entityType, entityId, body, prev, hash, at);
}

export function verifyAuditChain(): { ok: boolean; checked: number; brokenAt?: number } {
  const rows = db().prepare("SELECT * FROM audit_logs ORDER BY seq").all() as Array<Record<string, string | number>>;
  let prev = "GENESIS";
  for (const r of rows) {
    const h = hashStable(`${prev}|${r.actor_type}|${r.actor_id}|${r.action}|${r.entity_type}|${r.entity_id}|${r.details}|${r.at}`);
    if (r.prev_hash !== prev || r.hash !== h) return { ok: false, checked: rows.length, brokenAt: r.seq as number };
    prev = r.hash as string;
  }
  return { ok: true, checked: rows.length };
}
