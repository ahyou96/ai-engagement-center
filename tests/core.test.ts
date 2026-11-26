import { beforeAll, describe, expect, it } from "vitest";
import { freshDb } from "./setup";
import { all, one, run, db } from "../src/lib/db";
import { hashPassword, verifyPassword } from "../src/lib/auth";
import { can, maskRecord } from "../src/lib/rbac";
import { ingestEvents } from "../src/lib/cdp";
import { compile, createSegment, estimate, evaluateSegment, matchIds } from "../src/lib/segments";
import { evaluate, policies, validateContent } from "../src/lib/compliance";
import { sendMessages } from "../src/lib/messaging";
import { decideForPlayers, runBatch, issueOne, transition, reconcile } from "../src/lib/offers";
import { audit, verifyAuditChain } from "../src/lib/audit";
import { publish, replay } from "../src/lib/stream";
import { linkIdentity, resolveIdentity, applyProtection } from "../src/lib/cdp";

const U = { type: "user" as const, id: "crm@aec.local" };

beforeAll(() => { freshDb("core"); });

describe("authentication & permissions", () => {
  it("hashes and verifies passwords (scrypt)", () => {
    const h = hashPassword("demo1234");
    expect(verifyPassword("demo1234", h)).toBe(true);
    expect(verifyPassword("wrong", h)).toBe(false);
  });
  it("seeds demo users with roles", () => {
    expect(one<{ n: number }>("SELECT COUNT(*) n FROM users")!.n).toBe(7);
  });
  it("enforces role permissions", () => {
    expect(can("analyst", "campaigns.write")).toBe(false);
    expect(can("marketer", "campaigns.write")).toBe(true);
    expect(can("marketer", "approvals.decide")).toBe(false);
    expect(can("compliance_officer", "gaming_transactions.read")).toBe(true);
    expect(can("cs_agent", "finance.read")).toBe(false);
  });
  it("masks PII and financial fields by role", () => {
    const c = one<Record<string, unknown>>("SELECT * FROM customers LIMIT 1")!;
    const a = maskRecord("analyst", c);
    expect(String(a.email)).toContain("***");
    expect(a.deposit_total).toBe("restricted");
    expect(a._masked).toContain("phone");
    const f = maskRecord("finance", c);
    expect(f.deposit_total).toBe(c.deposit_total);
  });
});

describe("event ingestion", () => {
  it("validates, rejects unknown events and players", () => {
    const r = ingestEvents([{ event_id: "bad", event_name: "x" }, { event_id: "evt_unknown_1", event_name: "not_in_dictionary", player_id: "P100000" }, { event_id: "evt_unknown_2", event_name: "game_click", player_id: "NOPE", game_id: "gm_001" }]);
    expect(r.accepted).toBe(0);
    expect(r.rejected).toBe(3);
  });
  it("deduplicates by event_id", () => {
    const e = { event_id: "evt_dedupe_001", event_name: "game_launch_failed", player_id: "P100010", game_id: "gm_003", provider_id: "prv_03", error_code: "PROVIDER_TIMEOUT", loading_duration: 20000 };
    expect(ingestEvents([e]).accepted).toBe(1);
    const again = ingestEvents([e, e]);
    expect(again.accepted).toBe(0);
    expect(again.duplicates).toBe(2);
  });
  it("gaming events update the customer profile", () => {
    const before = one<{ launch_failures_7d: number }>("SELECT launch_failures_7d FROM customers WHERE player_id = 'P100020'")!.launch_failures_7d;
    ingestEvents([1, 2, 3].map((i) => ({ event_id: `evt_prof_${i}`, event_name: "game_launch_failed", player_id: "P100020", game_id: "gm_003", provider_id: "prv_03", loading_duration: 15000 })));
    expect(one<{ launch_failures_7d: number }>("SELECT launch_failures_7d FROM customers WHERE player_id = 'P100020'")!.launch_failures_7d).toBe(before + 3);
  });
  it("requires dictionary attributes", () => {
    const r = ingestEvents([{ event_id: "evt_missing_attr", event_name: "game_launch_failed", player_id: "P100020" }]);
    expect(r.rejected).toBe(1);
    expect(r.errors[0].reason).toMatch(/game_id/);
  });
});

describe("dynamic segmentation", () => {
  it("compiles nested AND/OR with parameters only (no injected SQL)", () => {
    const c = compile({ type: "group", op: "or", children: [{ type: "attr", field: "vip_tier", op: "eq", value: "gold'; DROP TABLE customers;--" }, { type: "group", op: "and", negate: true, children: [{ type: "tag", tag: "app_user", has: true }] }] });
    expect(c.sql).not.toContain("DROP");
    expect(c.params).toContain("gold'; DROP TABLE customers;--");
    expect(() => compile({ type: "attr", field: "password_hash", op: "eq", value: 1 })).toThrow();
  });
  it("adds and removes members automatically when events change", () => {
    const seg = createSegment({ name: "Test: ≥5 launch failures (1d)", type: "realtime", purpose: "service", rules: { type: "group", op: "and", children: [{ type: "event", event: "game_launch_failed", op: "gte", count: 5, within_days: 1 }] } }, U);
    const pid = "P100030";
    const inSeg = () => !!one("SELECT 1 FROM segment_memberships WHERE segment_id = ? AND player_id = ?", seg.id, pid);
    const wasIn = inSeg();
    ingestEvents([1, 2, 3, 4, 5].map((i) => ({ event_id: `evt_segin_${i}`, event_name: "game_launch_failed", player_id: pid, game_id: "gm_003", provider_id: "prv_03" })));
    expect(inSeg()).toBe(true);
    const h = all<{ action: string }>("SELECT action FROM segment_membership_history WHERE segment_id = ? AND player_id = ?", seg.id, pid);
    if (!wasIn) expect(h.map((x) => x.action)).toContain("enter");
    // exit: rule change makes player no longer match → exit recorded
    run("UPDATE segments SET rules = ? WHERE id = ?", JSON.stringify({ type: "group", op: "and", children: [{ type: "event", event: "game_launch_failed", op: "gte", count: 500, within_days: 1 }] }), seg.id);
    evaluateSegment(seg.id);
    expect(inSeg()).toBe(false);
    expect(all<{ action: string }>("SELECT action FROM segment_membership_history WHERE segment_id = ? AND player_id = ?", seg.id, pid).map((x) => x.action)).toContain("exit");
  });
  it("promotional segments always exclude self-excluded / RG-restricted players", () => {
    const rule = { type: "group" as const, op: "and" as const, children: [] };
    const promo = matchIds(rule, undefined, "marketing");
    const excluded = all<{ player_id: string }>("SELECT player_id FROM customers WHERE self_excluded = 1 OR rg_restricted = 1").map((r) => r.player_id);
    expect(excluded.length).toBeGreaterThan(0);
    expect(promo.some((p) => excluded.includes(p))).toBe(false);
    expect(estimate(rule, "service").count).toBeGreaterThan(estimate(rule, "marketing").count);
  });
  it("supports segment set operations (difference)", () => {
    const a = one<{ id: string }>("SELECT id FROM segments WHERE name = 'Gold & Platinum'")!.id;
    const b = one<{ id: string }>("SELECT id FROM segments WHERE name = 'App users'")!.id;
    const diff = matchIds({ type: "group", op: "and", children: [{ type: "segment", segment_id: a, in: true }, { type: "segment", segment_id: b, in: false }] });
    const appUsers = new Set(all<{ player_id: string }>("SELECT player_id FROM segment_memberships WHERE segment_id = ?", b).map((r) => r.player_id));
    expect(diff.length).toBeGreaterThan(0);
    expect(diff.every((p) => !appUsers.has(p))).toBe(true);
  });
});

describe("compliance", () => {
  it("blocks self-excluded players from marketing but allows protective contact", () => {
    const pid = one<{ player_id: string }>("SELECT player_id FROM customers WHERE self_excluded = 1 LIMIT 1")!.player_id;
    expect(evaluate({ playerIds: [pid], purpose: "marketing", action: "targeting" })[0].allowed).toBe(false);
    expect(evaluate({ playerIds: [pid], purpose: "protective", action: "targeting" })[0].allowed).toBe(true);
  });
  it("requires channel consent", () => {
    const pid = one<{ player_id: string }>("SELECT player_id FROM consent_current WHERE channel = 'whatsapp' AND purpose = 'service' AND granted = 0 LIMIT 1")!.player_id;
    const r = evaluate({ playerIds: [pid], purpose: "service", channel: "whatsapp", action: "message" })[0];
    expect(r.allowed).toBe(false);
    expect(r.reasons.map((x) => x.policy)).toContain("channel_consent");
  });
  it("enforces age eligibility (21+ demo default) for promotions", () => {
    const pid = one<{ player_id: string }>("SELECT player_id FROM customers WHERE age < 21 LIMIT 1")!.player_id;
    expect(evaluate({ playerIds: [pid], purpose: "marketing", action: "targeting" })[0].reasons.map((r) => r.policy)).toContain("age_eligibility");
  });
  it("mandatory policies cannot be disabled", () => {
    run("UPDATE compliance_policies SET enabled = 0 WHERE key = 'self_exclusion'");
    expect(policies().self_exclusion.enabled).toBe(true);
    run("UPDATE compliance_policies SET enabled = 1 WHERE key = 'self_exclusion'");
  });
  it("content validation rejects loss-chasing language and missing RG notice", () => {
    expect(validateContent("Win back your losses tonight!", "marketing").length).toBeGreaterThan(0);
    expect(validateContent("Free spins for you", "service").map((x) => x.policy)).toContain("purpose_mismatch");
    expect(validateContent("Tournament live. 21+ only. Play responsibly.", "marketing")).toEqual([]);
  });
});

describe("messaging", () => {
  it("is idempotent and enforces compliance on every send", () => {
    const ids = all<{ player_id: string }>("SELECT player_id FROM consent_current WHERE channel = 'inbox' AND purpose = 'service' AND granted = 1 LIMIT 20").map((r) => r.player_id);
    const r1 = sendMessages({ playerIds: ids, channel: "inbox", purpose: "service", templateId: "tpl_account_inbox", idempotencyPrefix: "test:idem", actor: U });
    const r2 = sendMessages({ playerIds: ids, channel: "inbox", purpose: "service", templateId: "tpl_account_inbox", idempotencyPrefix: "test:idem", actor: U });
    expect(r1.sent + r1.failed).toBe(ids.length);
    expect(r2.sent).toBe(0);
    expect(r2.duplicates).toBe(ids.length);
  });
  it("rejects unapproved templates and purpose mismatch", () => {
    expect(() => sendMessages({ playerIds: ["P100001"], channel: "sms", purpose: "marketing", templateId: "tpl_promo_sms_draft", idempotencyPrefix: "x", actor: U })).toThrow(/not approved/);
    expect(() => sendMessages({ playerIds: ["P100001"], channel: "inbox", purpose: "service", templateId: "tpl_member_inbox", idempotencyPrefix: "x", actor: U })).toThrow(/purpose/);
  });
});

describe("offers & budgets", () => {
  it("produces explainable, deterministic decisions", () => {
    const ids = all<{ player_id: string }>("SELECT player_id FROM customers ORDER BY player_id LIMIT 200").map((r) => r.player_id);
    const a = decideForPlayers("off_member_monthly", ids).decisions;
    const b = decideForPlayers("off_member_monthly", ids).decisions;
    expect(a).toEqual(b);
    expect(new Set(a.map((d) => d.outcome)).size).toBeGreaterThan(1);
    for (const d of a) { expect(d.reason.length).toBeGreaterThan(0); if (d.outcome === "none") expect(d.approved_amount).toBe(0); }
  });
  it("never uses deposits/losses: changing financial data does not change decisions", () => {
    const ids = all<{ player_id: string }>("SELECT player_id FROM customers ORDER BY player_id LIMIT 100").map((r) => r.player_id);
    const before = decideForPlayers("off_member_monthly", ids).decisions.map((d) => d.outcome);
    run("UPDATE customers SET deposit_total = deposit_total * 50, withdrawal_total = 0 WHERE player_id IN (" + ids.map(() => "?").join(",") + ")", ...ids);
    run("INSERT INTO gaming_transactions (id, player_id, game_id, provider_id, bet_amount, payout, settled_at) VALUES ('gtx_loss_test', ?, 'gm_001', 'prv_01', 100000, 0, ?)", ids[0], new Date().toISOString());
    expect(decideForPlayers("off_member_monthly", ids).decisions.map((d) => d.outcome)).toEqual(before);
  });
  it("gives excluded players no offer", () => {
    const pid = one<{ player_id: string }>("SELECT player_id FROM customers WHERE self_excluded = 1 AND kyc_status = 'verified' LIMIT 1")!.player_id;
    expect(decideForPlayers("off_member_monthly", [pid]).decisions[0].outcome).toBe("none");
  });
  it("prevents duplicate issuance (idempotent batch + per-user limit)", () => {
    const pid = one<{ player_id: string }>("SELECT player_id FROM customers WHERE kyc_status = 'verified' AND self_excluded = 0 AND rg_restricted = 0 AND age >= 21 AND account_status = 'active' AND marketing_opt_out = 0 LIMIT 1")!.player_id;
    const r1 = issueOne("off_member_monthly", pid, 100, "test:dup:1", null, U);
    const r2 = issueOne("off_member_monthly", pid, 100, "test:dup:1", null, U);
    const r3 = issueOne("off_member_monthly", pid, 100, "test:dup:2", null, U);
    expect(r1.status).toBe("issued"); expect(r2.status).toBe("duplicate"); expect(r3.status).toBe("duplicate");
  });
  it("never exceeds budget (atomic reservation) and reconciles", () => {
    run("UPDATE offer_budgets SET total = reserved + spent + 250 WHERE id = 'bud_comp'");
    run("UPDATE offers SET status = 'active' WHERE id = 'off_launch_comp'");
    const ids = all<{ player_id: string }>("SELECT player_id FROM customers WHERE kyc_status = 'verified' AND self_excluded = 0 AND rg_restricted = 0 ORDER BY player_id LIMIT 30").map((r) => r.player_id);
    let issued = 0;
    ids.forEach((p, i) => { if (issueOne("off_launch_comp", p, 50, `test:budget:${i}`, null, U).status === "issued") issued++; });
    expect(issued).toBeLessThanOrEqual(5);
    const b = one<{ total: number; reserved: number; spent: number }>("SELECT * FROM offer_budgets WHERE id = 'bud_comp'")!;
    expect(b.reserved + b.spent).toBeLessThanOrEqual(b.total);
    const tx = one<{ id: string }>("SELECT id FROM offer_transactions WHERE offer_id = 'off_launch_comp' LIMIT 1")!;
    transition(tx.id, "claimed", U); transition(tx.id, "redeemed", U);
    expect(() => transition(tx.id, "claimed", U)).toThrow();
    expect(reconcile().every((r) => (r as { balanced: boolean }).balanced)).toBe(true);
  });
  it("simulation persists decisions but issues nothing", () => {
    const ids = all<{ player_id: string }>("SELECT player_id FROM segment_memberships WHERE segment_id = 'seg_02' LIMIT 50").map((r) => r.player_id);
    const before = one<{ n: number }>("SELECT COUNT(*) n FROM offer_transactions")!.n;
    const r = runBatch("off_member_monthly", ids, { simulate: true, actor: U });
    expect(r.decisions.length).toBe(ids.length);
    expect(one<{ n: number }>("SELECT COUNT(*) n FROM offer_transactions")!.n).toBe(before);
  });
});

describe("identity resolution", () => {
  it("links verified identities and queues uncertain ones for review", () => {
    expect(linkIdentity({ player_id: "P100040", type: "telegram", value: "tg-test-1", verified: true, source: "telegram_optin" }, U).status).toBe("linked");
    expect(resolveIdentity("telegram", "tg-test-1")?.player_id).toBe("P100040");
    expect(linkIdentity({ player_id: "P100041", type: "telegram", value: "tg-test-1", verified: true, source: "x" }, U).status).toBe("pending_review");
    expect(linkIdentity({ player_id: "P100041", type: "telegram", value: "tg-test-2", verified: false, source: "x" }, U).status).toBe("pending_review");
    expect(resolveIdentity("telegram", "tg-test-1")?.player_id).toBe("P100040");
  });
});

describe("responsible gaming protection (Scenario E)", () => {
  it("excludes the player everywhere and stops pending promotional activity", () => {
    const pid = one<{ player_id: string }>("SELECT m.player_id FROM segment_memberships m JOIN segments s ON s.id = m.segment_id JOIN customers c ON c.player_id = m.player_id WHERE s.purpose IN ('marketing','membership') AND c.self_excluded = 0 LIMIT 1")!.player_id;
    run("INSERT INTO messages (id, org_id, idempotency_key, player_id, channel, purpose, status, created_at, updated_at) VALUES ('msg_q1','org_demo','q1',?,'app_push','marketing','queued',?,?)", pid, new Date().toISOString(), new Date().toISOString());
    const r = ingestEvents([{ event_id: "evt_rg_test_1", event_name: "self_exclusion_enabled", player_id: pid }]);
    expect(r.accepted).toBe(1);
    expect(one<{ self_excluded: number }>("SELECT self_excluded FROM customers WHERE player_id = ?", pid)!.self_excluded).toBe(1);
    expect(all("SELECT 1 FROM segment_memberships m JOIN segments s ON s.id = m.segment_id WHERE m.player_id = ? AND s.purpose IN ('marketing','membership')", pid).length).toBe(0);
    expect(one<{ status: string }>("SELECT status FROM messages WHERE id = 'msg_q1'")!.status).toBe("cancelled");
    expect(evaluate({ playerIds: [pid], purpose: "membership", action: "offer" })[0].allowed).toBe(false);
    expect(one("SELECT 1 FROM audit_logs WHERE action = 'compliance.protection_applied' AND entity_id = ?", pid)).toBeTruthy();
    expect(one("SELECT 1 FROM service_tickets WHERE player_id = ? AND category = 'responsible_gaming'", pid)).toBeTruthy();
    expect(applyProtection(pid, "self_exclusion", "repeat").steps.length).toBeGreaterThan(3);
  });
});

describe("audit & streaming", () => {
  it("audit log is append-only and hash-chained", () => {
    audit(U, "test.action", "x", "1", { a: 1 });
    expect(verifyAuditChain().ok).toBe(true);
    expect(() => run("UPDATE audit_logs SET action = 'tampered' WHERE seq = 1")).toThrow(/append-only/);
    expect(() => run("DELETE FROM audit_logs")).toThrow(/append-only/);
  });
  it("stream events are ordered and replayable after a given id", () => {
    const a = publish("test", "t", { n: 1 }); const b = publish("test", "t", { n: 2 }); publish("test", "t", { n: 3 });
    const r = replay(a.seq, ["test"]);
    expect(r.map((e) => (e.payload as { n: number }).n)).toEqual([2, 3]);
    expect(r[0].seq).toBe(b.seq);
    expect(db()).toBeTruthy();
  });
});
