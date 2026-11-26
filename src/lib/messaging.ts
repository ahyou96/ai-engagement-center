import crypto from "node:crypto";
import { all, db, J, one, run, tx } from "./db";
import { audit, Actor } from "./audit";
import { evaluate, Purpose, validateContent, isPromotional, PlayerCheck } from "./compliance";
import { bucket, HttpError, id, nowIso, ORG_ID } from "./util";
import { publish } from "./stream";
import { createApproval } from "./approvals";

export type Channel = { key: string; name: string; provider: string; mode: string; connection_status: string; cost_per_message: number; consent_channel: string; fallback_channels: string; config: string; enabled: number; health: string; retry_policy: string; restrictions: string | null; verified_at: string | null };

/** Unified provider adapter interface. Real adapters are registered only once credentials are verified. */
export interface ChannelAdapter {
  key: string;
  send(msg: { id: string; player_id: string; body: string; channel: Channel }): { status: "sent" | "failed"; providerRef?: string; errorCode?: string };
}
const mockAdapter: ChannelAdapter = {
  key: "mock",
  send(msg) {
    const cfg = J.parse<{ mock_send_failure_rate?: number }>(msg.channel.config, {});
    const r = bucket(`send:${msg.id}`);
    if (r < (cfg.mock_send_failure_rate ?? 0.01)) return { status: "failed", errorCode: pickErr(msg.channel.key, r) };
    return { status: "sent", providerRef: `mock-${msg.id.slice(-8)}` };
  },
};
function pickErr(channel: string, r: number) {
  const codes: Record<string, string[]> = { sms: ["SMS_CARRIER_REJECTED", "SMS_ROUTE_UNAVAILABLE", "SMS_THROTTLED"], whatsapp: ["WA_TEMPLATE_NOT_APPROVED", "WA_USER_UNREACHABLE"], email: ["EMAIL_BOUNCE_HARD", "EMAIL_BOUNCE_SOFT"], viber: ["VIBER_NOT_SUBSCRIBED"] };
  const list = codes[channel] ?? ["PROVIDER_ERROR"];
  return list[Math.floor(r * 1000) % list.length];
}
export function adapterFor(c: Channel): ChannelAdapter {
  if (c.mode === "live") {
    // Live adapters are intentionally not shipped enabled. See docs/INTEGRATIONS.md for enabling a verified provider.
    if (process.env.AEC_ALLOW_REAL_SENDING !== "true" || c.connection_status !== "verified") throw new HttpError(409, `Channel ${c.key} is not verified for live sending`);
    throw new HttpError(501, `Live adapter for ${c.provider} not configured`);
  }
  return mockAdapter;
}

export function renderTemplate(body: string, vars: Record<string, unknown>) {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] == null ? "" : String(vars[k])));
}

export type SendRequest = {
  playerIds: string[]; channel: string; purpose: Purpose; templateId?: string; body?: string; idempotencyPrefix: string;
  campaignId?: string; journeyId?: string; runId?: string; variant?: string; actor: Actor; context?: string; simulateOnly?: boolean;
};
export type SendResult = { sent: number; blocked: number; duplicates: number; failed: number; messageIds: string[]; blockedDetails: PlayerCheck[]; cost: number };

/**
 * The only path that creates outbound messages. Enforces: emergency stop, compliance (consent, exclusions,
 * frequency caps, quiet hours), content standards, channel availability, and idempotency.
 */
export function sendMessages(req: SendRequest): SendResult {
  const ch = one<Channel>("SELECT * FROM channels WHERE key = ?", req.channel);
  if (!ch) throw new HttpError(400, `Unknown channel ${req.channel}`);
  if (!ch.enabled) throw new HttpError(409, `Channel ${req.channel} is disabled`);
  let body = req.body ?? "";
  if (req.templateId) {
    const t = one<{ body: string; status: string; purpose: string; channel: string }>("SELECT body, status, purpose, channel FROM message_templates WHERE id = ?", req.templateId);
    if (!t) throw new HttpError(400, "Template not found");
    if (t.status !== "approved") throw new HttpError(409, "Template is not approved");
    if (isPromotional(t.purpose) !== isPromotional(req.purpose)) throw new HttpError(409, `Template purpose ${t.purpose} does not match send purpose ${req.purpose}`);
    body = t.body;
  }
  const contentIssues = validateContent(body, req.purpose);
  if (contentIssues.length) throw new HttpError(422, "Content failed compliance validation", contentIssues);

  const checks = evaluate({ playerIds: req.playerIds, purpose: req.purpose, channel: req.channel, action: "message", context: req.context ?? "send", refId: req.campaignId ?? req.journeyId ?? req.runId });
  const allowed = checks.filter((c) => c.allowed).map((c) => c.player_id);
  const res: SendResult = { sent: 0, blocked: checks.length - allowed.length, duplicates: 0, failed: 0, messageIds: [], blockedDetails: checks.filter((c) => !c.allowed).slice(0, 50), cost: 0 };
  if (req.simulateOnly) { res.sent = allowed.length; res.cost = allowed.length * ch.cost_per_message; return res; }

  const adapter = adapterFor(ch);
  const names = new Map(all<{ player_id: string; display_name: string }>(`SELECT player_id, display_name FROM customers WHERE player_id IN (${allowed.map(() => "?").join(",") || "''"})`, ...allowed).map((r) => [r.player_id, r.display_name]));
  const ins = db().prepare(`INSERT OR IGNORE INTO messages (id, org_id, idempotency_key, player_id, channel, template_id, purpose, campaign_id, journey_id, run_id, variant, status, cost, error_code, simulated, body_preview, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`);
  const t = nowIso();
  tx(() => {
    for (const pid of allowed) {
      const key = `${req.idempotencyPrefix}:${pid}:${req.channel}`;
      const mid = id("msg");
      const text = renderTemplate(body, { first_name: (names.get(pid) ?? "").split(" ")[0], player_id: pid });
      const out = adapter.send({ id: mid, player_id: pid, body: text, channel: ch });
      const info = ins.run(mid, ORG_ID, key, pid, req.channel, req.templateId ?? null, req.purpose, req.campaignId ?? null, req.journeyId ?? null, req.runId ?? null, req.variant ?? null,
        out.status, out.status === "sent" ? ch.cost_per_message : 0, out.errorCode ?? null, text.slice(0, 160), t, t);
      if (info.changes === 0) { res.duplicates++; db().prepare("INSERT INTO duplicate_prevention_log (kind, key, player_id, at) VALUES ('message', ?, ?, ?)").run(key, pid, t); continue; }
      res.messageIds.push(mid);
      if (out.status === "sent") { res.sent++; res.cost += ch.cost_per_message; simulateDelivery(mid, ch); }
      else { res.failed++; db().prepare("INSERT OR IGNORE INTO delivery_events (message_id, status, error_code, at) VALUES (?,?,?,?)").run(mid, "failed", out.errorCode, t); }
    }
  });
  audit(req.actor, "message.send", req.campaignId ? "campaign" : req.journeyId ? "journey" : req.runId ? "workflow_run" : "message", req.campaignId ?? req.journeyId ?? req.runId ?? null,
    { channel: req.channel, purpose: req.purpose, requested: req.playerIds.length, sent: res.sent, blocked: res.blocked, duplicates: res.duplicates, failed: res.failed, simulated: true });
  publish("delivery", "messages.sent", { channel: req.channel, purpose: req.purpose, sent: res.sent, blocked: res.blocked, failed: res.failed, duplicates: res.duplicates, campaign_id: req.campaignId, journey_id: req.journeyId, run_id: req.runId });
  return res;
}

/** Mock provider callbacks: deterministic delivered/read/clicked based on channel config. */
function simulateDelivery(mid: string, ch: Channel) {
  const cfg = J.parse<{ mock_delivery_rate?: number; mock_read_rate?: number; mock_click_rate?: number }>(ch.config, {});
  const ins = db().prepare("INSERT OR IGNORE INTO delivery_events (message_id, status, error_code, at) VALUES (?,?,?,?)");
  const t = nowIso();
  ins.run(mid, "sent", null, t);
  const r = bucket(`dl:${mid}`);
  if (r < (cfg.mock_delivery_rate ?? 0.96)) {
    ins.run(mid, "delivered", null, t);
    let status = "delivered";
    if (bucket(`rd:${mid}`) < (cfg.mock_read_rate ?? 0.5)) { ins.run(mid, "read", null, t); status = "read"; if (bucket(`ck:${mid}`) < (cfg.mock_click_rate ?? 0.15)) { ins.run(mid, "clicked", null, t); status = "clicked"; } }
    db().prepare("UPDATE messages SET status = ?, updated_at = ? WHERE id = ?").run(status, t, mid);
  } else {
    const code = pickErr(ch.key, r);
    ins.run(mid, "failed", code, t);
    db().prepare("UPDATE messages SET status = 'failed', error_code = ?, updated_at = ? WHERE id = ?").run(code, t, mid);
  }
}

/** Inbound provider webhook (delivery receipts). Signature = hex HMAC-SHA256(body, AEC_WEBHOOK_SECRET). */
export function verifyWebhookSignature(rawBody: string, signature: string | null) {
  if (!signature) return false;
  const expected = crypto.createHmac("sha256", process.env.AEC_WEBHOOK_SECRET ?? "dev-webhook-secret").update(rawBody).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const ORDER = ["queued", "sent", "delivered", "read", "clicked"];
export function ingestDeliveryEvent(e: { message_id: string; status: string; error_code?: string; provider_ref?: string }) {
  const m = one<{ status: string }>("SELECT status FROM messages WHERE id = ?", e.message_id);
  if (!m) throw new HttpError(404, "Unknown message");
  const info = run("INSERT OR IGNORE INTO delivery_events (message_id, status, error_code, provider_ref, at) VALUES (?,?,?,?,?)", e.message_id, e.status, e.error_code ?? null, e.provider_ref ?? null, nowIso());
  if (info.changes === 0) return { duplicate: true };
  const terminal = ["failed", "rejected", "unsubscribed", "cancelled"];
  if (terminal.includes(e.status) || ORDER.indexOf(e.status) > ORDER.indexOf(m.status)) run("UPDATE messages SET status = ?, error_code = COALESCE(?, error_code), updated_at = ? WHERE id = ?", e.status, e.error_code ?? null, nowIso(), e.message_id);
  if (e.status === "unsubscribed") {
    const pid = one<{ player_id: string; channel: string }>("SELECT player_id, channel FROM messages WHERE id = ?", e.message_id)!;
    run("INSERT OR REPLACE INTO consent_current (player_id, channel, purpose, granted, updated_at) VALUES (?,?,?,0,?)", pid.player_id, pid.channel, "marketing", nowIso());
    run("INSERT INTO consent_records (player_id, channel, purpose, granted, source, recorded_at) VALUES (?,?,?,0,'provider_unsubscribe',?)", pid.player_id, pid.channel, "marketing", nowIso());
  }
  publish("delivery", "delivery.event", e, e.message_id);
  return { duplicate: false };
}

export function cancelPendingMessages(playerId: string, opts: { promotionalOnly: boolean; journeyId?: string }, actor: Actor) {
  const where = ["player_id = ?", "status = 'queued'"]; const params: unknown[] = [playerId];
  if (opts.promotionalOnly) where.push("purpose IN ('membership','marketing','regulated_promotion')");
  if (opts.journeyId) { where.push("journey_id = ?"); params.push(opts.journeyId); }
  const info = run(`UPDATE messages SET status = 'cancelled', updated_at = ? WHERE ${where.join(" AND ")}`, nowIso(), ...params);
  if (info.changes) audit(actor, "message.cancelled", "customer", playerId, { count: info.changes, ...opts });
  return info.changes;
}

// ───── templates ─────
export function submitTemplate(templateId: string, actor: Actor) {
  const t = one<{ id: string; name: string; body: string; purpose: string; channel: string }>("SELECT * FROM message_templates WHERE id = ?", templateId);
  if (!t) throw new HttpError(404, "Template not found");
  const issues = validateContent(t.body, t.purpose);
  run("UPDATE message_templates SET compliance_result = ?, status = ?, updated_at = ? WHERE id = ?", J.str({ passed: !issues.length, issues }), issues.length ? "changes_required" : "pending_approval", nowIso(), templateId);
  if (issues.length) return { passed: false, issues };
  const a = createApproval({ entityType: "template", entityId: templateId, title: `Template: ${t.name} (${t.channel})`, summary: t.body.slice(0, 200), risk: isPromotional(t.purpose) ? "medium" : "low", requestedBy: actor.id });
  return { passed: true, approvalId: a.id };
}
export function onTemplateApproval(templateId: string, status: string, actor: Actor) {
  const s = status === "approved" ? "approved" : status === "rejected" ? "rejected" : "draft";
  run("UPDATE message_templates SET status = ?, provider_approval = CASE WHEN channel IN ('whatsapp','viber','messenger') THEN 'pending_provider' ELSE provider_approval END, updated_at = ? WHERE id = ?", s, nowIso(), templateId);
  audit(actor, `template.${s}`, "template", templateId, {});
}

export function channelStats(hours = 24 * 7) {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  return all<{ channel: string; total: number; delivered: number; read: number; clicked: number; failed: number; cost: number }>(`
    SELECT channel, COUNT(*) total,
      SUM(CASE WHEN status IN ('delivered','read','clicked') THEN 1 ELSE 0 END) delivered,
      SUM(CASE WHEN status IN ('read','clicked') THEN 1 ELSE 0 END) read,
      SUM(CASE WHEN status = 'clicked' THEN 1 ELSE 0 END) clicked,
      SUM(CASE WHEN status IN ('failed','rejected') THEN 1 ELSE 0 END) failed, ROUND(SUM(cost),2) cost
    FROM messages WHERE created_at >= ? GROUP BY channel`, since);
}
