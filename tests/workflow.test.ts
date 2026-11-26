import { beforeAll, describe, expect, it } from "vitest";
import { freshDb } from "./setup";
import { all, one, run } from "../src/lib/db";
import { startRun, drive, recoverRuns, emergencyStop, retryNode, runDetail, pauseRun, resumeRun } from "../src/lib/workflow/engine";
import { decide } from "../src/lib/approvals";
import { getActiveStrategy, rollback } from "../src/lib/strategy";
import { createCampaign, submitCampaign, executeCampaign } from "../src/lib/campaigns";
import { validate, publishJourney, enroll, simulate, saveDraft, JourneyDef } from "../src/lib/journeys";
import { setAttribute } from "../src/lib/cdp";
import { evaluateSegment } from "../src/lib/segments";

const OPS = { type: "user" as const, id: "ops@aec.local" };
const COMP = { type: "user" as const, id: "compliance@aec.local" };
const CRM = { type: "user" as const, id: "crm@aec.local" };
const status = (id: string) => one<{ status: string }>("SELECT status FROM ai_workflow_runs WHERE id = ?", id)!.status;
const pendingApprovalFor = (runId: string) => one<{ id: string }>("SELECT a.id FROM approvals a JOIN decisions d ON d.id = a.entity_id WHERE d.run_id = ? AND a.status = 'pending'", runId)?.id;
const settle = async (runId: string) => { for (let i = 0; i < 50 && ["running"].includes(status(runId)); i++) await new Promise((r) => setTimeout(r, 20)); };

beforeAll(() => {
  freshDb("wf", 2500, 30000);
  // smaller synthetic population in tests → lower the configured minimum sample (default 200)
  run("UPDATE settings SET value = json_set(value, '$.min_sample', 100) WHERE key = 'optimizer'");
});

describe("Scenario A — provider failure (manual mode)", () => {
  let runId = "";
  it("detects the incident and pauses at the approval gateway", async () => {
    const r = startRun({ scenario: "provider_failure", mode: "manual", actor: OPS });
    runId = r.runId; await r.promise;
    expect(status(runId)).toBe("waiting_approval");
    const d = runDetail(runId);
    expect(d.nodes.find((n) => n.node_key === "discovery")!.summary).toMatch(/Nebula Play/);
    expect(d.nodes.find((n) => n.node_key === "offer_eligibility")!.status).toBe("skipped");
    expect(d.tools.length).toBeGreaterThan(5);
    expect(d.run.strategy_version).toBe(4);
    expect(one("SELECT 1 FROM opportunities WHERE run_id = ?", runId)).toBeTruthy();
  });
  it("cannot be approved by the requesting agent's own identity; approval resumes execution", async () => {
    const aid = pendingApprovalFor(runId)!;
    await expect(decide(aid, { type: "agent", id: "agent:decision" }, "approve")).rejects.toThrow(/own approval/);
    await decide(aid, OPS, "approve");
    const a = one<{ status: string; required_levels: number }>("SELECT status, required_levels FROM approvals WHERE id = ?", aid)!;
    if (a.status === "pending") await decide(aid, COMP, "approve"); // high-risk → 2 levels
    await settle(runId);
    expect(status(runId)).toBe("completed");
    const d = runDetail(runId);
    expect(d.nodes.find((n) => n.node_key === "execution")!.status).toBe("completed");
    expect(one<{ n: number }>("SELECT COUNT(*) n FROM messages WHERE run_id = ?", runId)!.n).toBeGreaterThan(0);
    // compliance enforced at send: no self-excluded marketing is relevant here, but consent is — every message has service consent
    const noConsent = one<{ n: number }>("SELECT COUNT(*) n FROM messages m WHERE m.run_id = ? AND NOT EXISTS (SELECT 1 FROM consent_current c JOIN channels ch ON ch.consent_channel = c.channel WHERE ch.key = m.channel AND c.player_id = m.player_id AND c.purpose = 'service' AND c.granted = 1)", runId)!.n;
    expect(noConsent).toBe(0);
  });
  it("optimizer generated a candidate; after approval the NEXT run uses the new version; rollback restores", async () => {
    const opt = runDetail(runId).nodes.find((n) => n.node_key === "optimizer")!;
    const out = opt.output as { candidate_version?: number; verdict?: string };
    expect(out.candidate_version).toBe(5);
    expect(out.verdict).toBe("promote");
    const apr = one<{ id: string }>("SELECT id FROM approvals WHERE entity_type = 'strategy_version' AND status = 'pending'")!;
    await decide(apr.id, OPS, "approve");
    expect(getActiveStrategy("provider_monitoring").version).toBe(5);
    const r2 = startRun({ scenario: "provider_failure", mode: "manual", simulation: true, actor: OPS });
    await r2.promise; await settle(r2.runId);
    expect(runDetail(r2.runId).run.strategy_version).toBe(5);
    // the earlier run stays pinned to v4
    expect(runDetail(runId).run.strategy_version).toBe(4);
    const rb = rollback("str_provider_monitoring", OPS, "test");
    expect(rb).toEqual({ from: 5, to: 4 });
    expect(getActiveStrategy("provider_monitoring").version).toBe(4);
  });
});

describe("Scenario B — KYC (automatic mode, low-risk actions auto-execute)", () => {
  it("publishes the service journey without human approval and exits verified players", async () => {
    const r = startRun({ scenario: "kyc_assistance", mode: "auto", actor: OPS });
    await r.promise; await settle(r.runId);
    expect(status(r.runId)).toBe("completed");
    const d = runDetail(r.runId);
    expect((d.nodes.find((n) => n.node_key === "approval")!.output as { auto: boolean }).auto).toBe(true);
    const execs = all<{ player_id: string; id: string }>("SELECT id, player_id FROM journey_executions WHERE journey_id = 'jrn_kyc' AND status IN ('active','waiting')");
    expect(execs.length).toBeGreaterThan(0);
    // player completes KYC → leaves segment → pending reminders stop
    const pid = execs[0].player_id;
    setAttribute(pid, "kyc_status", "verified", "test");
    evaluateSegment(one<{ id: string }>("SELECT id FROM segments WHERE name = 'KYC stalled'")!.id);
    await new Promise((r) => setTimeout(r, 50));
    expect(one<{ status: string; exit_reason: string }>("SELECT status, exit_reason FROM journey_executions WHERE id = ?", execs[0].id)).toEqual({ status: "exited", exit_reason: "left_trigger_segment" });
    // enrolling again is a no-op (no duplicate reminders)
    const again = enroll("jrn_kyc", [execs[1].player_id], "test");
    expect(again.enrolled).toBe(0);
  });
});

describe("Scenario C — entitlements require approval; Scenario D — channel recovery", () => {
  it("C waits for approval (issue_entitlement is never auto-executed)", async () => {
    const r = startRun({ scenario: "membership_entitlements", mode: "auto", actor: OPS });
    await r.promise;
    expect(status(r.runId)).toBe("waiting_approval");
    const elig = runDetail(r.runId).nodes.find((n) => n.node_key === "offer_eligibility")!;
    expect(elig.summary).toMatch(/Enhanced/);
    const aid = pendingApprovalFor(r.runId)!;
    await decide(aid, OPS, "approve"); await settle(r.runId);
    expect(status(r.runId)).toBe("completed");
    expect(one<{ n: number }>("SELECT COUNT(*) n FROM offer_transactions WHERE offer_id = 'off_member_monthly'")!.n).toBeGreaterThan(0);
    const b = one<{ total: number; reserved: number; spent: number }>("SELECT * FROM offer_budgets WHERE id = 'bud_member'")!;
    expect(b.reserved + b.spent).toBeLessThanOrEqual(b.total);
  });
  it("D detects degraded SMS and resends via consented fallbacks", async () => {
    const r = startRun({ scenario: "channel_delivery", mode: "manual", actor: OPS });
    await r.promise;
    expect(status(r.runId)).toBe("waiting_approval");
    await decide(pendingApprovalFor(r.runId)!, COMP, "approve");
    const a = one<{ id: string; status: string }>("SELECT a.id, a.status FROM approvals a JOIN decisions d ON d.id = a.entity_id WHERE d.run_id = ?", r.runId)!;
    if (a.status === "pending") await decide(a.id, OPS, "approve");
    await settle(r.runId);
    expect(status(r.runId)).toBe("completed");
    const sent = all<{ channel: string }>("SELECT DISTINCT channel FROM messages WHERE run_id = ?", r.runId).map((x) => x.channel);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent).not.toContain("sms");
  });
});

describe("Scenario E via workflow", () => {
  it("verifies protection end-to-end and does not optimize engagement", async () => {
    const r = startRun({ scenario: "rg_protection", mode: "auto", actor: COMP });
    await r.promise; await settle(r.runId);
    expect(status(r.runId)).toBe("completed");
    const d = runDetail(r.runId);
    expect((d.nodes.find((n) => n.node_key === "compliance")!.output as { passed: boolean }).passed).toBe(true);
    expect(d.nodes.find((n) => n.node_key === "optimizer")!.summary).toMatch(/never optimized for engagement/);
  });
});

describe("workflow controls", () => {
  it("retries a failed node after an injected failure", async () => {
    const r = startRun({ scenario: "rg_protection", mode: "auto", simulation: true, actor: OPS, injectFailure: "customer_intel" });
    await r.promise;
    expect(status(r.runId)).toBe("failed");
    await retryNode(r.runId, "customer_intel", OPS); await settle(r.runId);
    expect(status(r.runId)).toBe("completed");
    expect(one<{ attempt: number }>("SELECT attempt FROM ai_node_executions WHERE run_id = ? AND node_key = 'customer_intel'", r.runId)!.attempt).toBe(2);
  });
  it("recovers runs left 'running' after a restart", async () => {
    const r = startRun({ scenario: "rg_protection", mode: "auto", simulation: true, actor: OPS });
    await r.promise;
    // simulate a crash mid-run: rewind state to 'running' with a node stuck in running
    run("UPDATE ai_workflow_runs SET status = 'running', finished_at = NULL WHERE id = ?", r.runId);
    run("UPDATE ai_node_executions SET status = 'running' WHERE run_id = ? AND node_key = 'analytics'", r.runId);
    run("UPDATE ai_node_executions SET status = 'pending' WHERE run_id = ? AND node_key = 'optimizer'", r.runId);
    expect(recoverRuns()).toBeGreaterThanOrEqual(1);
    await settle(r.runId); await new Promise((x) => setTimeout(x, 50));
    expect(status(r.runId)).toBe("completed");
    expect(all("SELECT 1 FROM stream_events WHERE ref_id = ? AND type = 'run.recovered'", r.runId).length).toBe(1);
  });
  it("pause / resume", async () => {
    const r = startRun({ scenario: "kyc_assistance", mode: "auto", simulation: true, actor: OPS });
    pauseRun(r.runId, OPS);
    await r.promise;
    expect(status(r.runId)).toBe("paused");
    await resumeRun(r.runId, OPS); await settle(r.runId);
    expect(["completed", "waiting_approval"]).toContain(status(r.runId));
  });
  it("emergency stop halts runs, pauses journeys and blocks non-simulation starts", async () => {
    const r = startRun({ scenario: "provider_failure", mode: "manual", actor: OPS });
    await r.promise;
    const res = await emergencyStop(OPS, true);
    expect(res.active).toBe(true);
    expect(status(r.runId)).toBe("stopped");
    expect(() => startRun({ scenario: "provider_failure", actor: OPS })).toThrow(/Emergency stop/);
    expect(one<{ n: number }>("SELECT COUNT(*) n FROM journeys WHERE status = 'active'")!.n).toBe(0);
    await emergencyStop(OPS, false);
  });
});

describe("campaigns & journeys", () => {
  it("campaign: validate → submit → approve (separation of duties) → execute (mock)", async () => {
    const c = createCampaign({ name: "Test service notice", objective: "service_communication", segment_id: "seg_17", channels: ["inbox", "sms"], template_id: "tpl_account_inbox" }, CRM);
    expect(() => executeCampaign(c.id, CRM)).toThrow(/approved/);
    const s = submitCampaign(c.id, CRM);
    await expect(decide(s.approvalId, CRM, "approve")).rejects.toThrow(/own approval/);
    await decide(s.approvalId, OPS, "approve");
    const r = executeCampaign(c.id, OPS);
    expect(r.sent).toBeGreaterThan(0);
    expect(executeCampaign.length).toBeGreaterThan(0);
  });
  it("journey validation detects cycles and missing config", () => {
    const def: JourneyDef = { nodes: [{ id: "t", type: "trigger", kind: "manual", data: {} }, { id: "a", type: "action", kind: "send_message", data: {} }, { id: "b", type: "flow", kind: "wait", data: { hours: 1 } }], edges: [{ id: "1", source: "t", target: "a" }, { id: "2", source: "a", target: "b" }, { id: "3", source: "b", target: "a" }] };
    const issues = validate(def, "service");
    expect(issues.some((i) => /cycle/i.test(i.message))).toBe(true);
    expect(issues.some((i) => /channel/i.test(i.message))).toBe(true);
  });
  it("journey simulation counts per node without side effects", () => {
    const before = one<{ n: number }>("SELECT COUNT(*) n FROM messages")!.n;
    const j = one<{ draft_definition: string }>("SELECT draft_definition FROM journeys WHERE id = 'jrn_ios'")!;
    const sim = simulate(JSON.parse(j.draft_definition), "service", 100);
    expect(sim.counts.t1.entered).toBe(sim.sample);
    expect((sim.counts.a1?.entered ?? 0) + (sim.counts.a2?.entered ?? 0)).toBe(sim.sample);
    expect(one<{ n: number }>("SELECT COUNT(*) n FROM messages")!.n).toBe(before);
  });
  it("promotional journeys require approval to publish", () => {
    const j = one<{ draft_definition: string }>("SELECT draft_definition FROM journeys WHERE id = 'jrn_tourney'")!;
    saveDraft("jrn_tourney", JSON.parse(j.draft_definition), CRM);
    expect(publishJourney("jrn_tourney", CRM).status).toBe("pending_approval");
  });
});
