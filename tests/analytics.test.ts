import { beforeAll, describe, expect, it } from "vitest";
import { freshDb } from "./setup";
import { one } from "../src/lib/db";
import { overview, parseFilters, gamingFunnel, attribution } from "../src/lib/metrics";
import { copilotTurn, parseSegment, Part } from "../src/lib/ai/copilot";
import { estimate } from "../src/lib/segments";
import { ingestEvents } from "../src/lib/cdp";

const USER = { id: "usr_admin", email: "admin@aec.local", name: "A", role_id: "admin", org_id: "org_demo", language: "en" };
beforeAll(() => { freshDb("an"); });

describe("dashboard metric consistency", () => {
  it("overview metrics equal direct queries on shared tables", () => {
    const o = overview(parseFilters(new URLSearchParams({ days: "7" })));
    const m = (k: string) => [...o.customer, ...o.gaming, ...o.engagement].find((x) => x.key === k)!;
    expect(m("total_users").value).toBe(one<{ n: number }>("SELECT COUNT(*) n FROM customers")!.n);
    const kyc = one<{ v: number; n: number }>("SELECT SUM(kyc_status='verified') v, COUNT(*) n FROM customers")!;
    expect(m("kyc_rate").value).toBeCloseTo(kyc.v / kyc.n, 6);
    for (const x of [...o.customer, ...o.gaming, ...o.engagement, ...o.ai, ...o.offers]) { expect(x.definition.length).toBeGreaterThan(5); expect(x.formula.length).toBeGreaterThan(2); }
  });
  it("filters change query results (platform)", () => {
    const all7 = overview(parseFilters(new URLSearchParams({ days: "7" })));
    const app = overview(parseFilters(new URLSearchParams({ days: "7", platform: "app" })));
    const v = (o: typeof all7) => o.customer.find((x) => x.key === "total_users")!.value!;
    expect(v(app)).toBeLessThan(v(all7));
    expect(v(app)).toBe(one<{ n: number }>("SELECT COUNT(*) n FROM customers WHERE primary_platform = 'app'")!.n);
  });
  it("ingested gaming events are reflected in launch metrics", () => {
    const f = parseFilters(new URLSearchParams({ days: "1" }));
    const before = gamingFunnel(f).funnel.find((s) => s.step === "game_launch_start")!.players;
    const pid = one<{ player_id: string }>("SELECT player_id FROM customers c WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.player_id = c.player_id AND e.event_name = 'game_launch_start' AND e.event_time >= ?) LIMIT 1", f.from)!.player_id;
    ingestEvents([{ event_id: "evt_metric_1", event_name: "game_launch_start", player_id: pid, game_id: "gm_001", provider_id: "prv_01" }]);
    expect(gamingFunnel(parseFilters(new URLSearchParams({ days: "1" }))).funnel.find((s) => s.step === "game_launch_start")!.players).toBe(before + 1);
  });
  it("attribution is labelled as correlation", () => {
    expect(attribution(parseFilters(new URLSearchParams({ days: "30" }))).caveat).toMatch(/CORRELATION/);
  });
});

describe("AI segment builder & copilot streaming", () => {
  it("parses the reference natural-language segment", () => {
    const p = parseSegment("Find users who experienced game loading failures in the last seven days and have unresolved customer service tickets.");
    expect(p.rule).toEqual({ type: "group", op: "and", children: [{ type: "event", event: "game_launch_failed", op: "gte", count: 1, within_days: 7 }, { type: "attr", field: "open_tickets", op: "gt", value: 0 }] });
    expect(estimate(p.rule).count).toBeGreaterThan(0);
  });
  it("refuses vulnerability/loss-based targeting", () => {
    expect(parseSegment("players who lost the most money this week for a bonus").refused).toBeTruthy();
  });
  it("streams tool events, text tokens and structured parts in order, then persists", async () => {
    const parts: Part[] = [];
    const ctrl = new AbortController();
    const cid = await copilotTurn({ user: USER, message: "Which gaming providers have launch failures today?", signal: ctrl.signal, emit: (p) => parts.push(p) });
    const types = parts.map((p) => p.type);
    expect(types[0]).toBe("meta");
    expect(types.indexOf("tool_start")).toBeLessThan(types.indexOf("tool_end"));
    expect(types.filter((t) => t === "text").length).toBeGreaterThan(10);
    expect(types).toContain("table");
    expect(types[types.length - 1]).toBe("done");
    expect(one<{ n: number }>("SELECT COUNT(*) n FROM copilot_messages WHERE conversation_id = ?", cid)!.n).toBe(2);
  });
  it("supports cancellation", async () => {
    const parts: Part[] = []; const ctrl = new AbortController();
    process.env.AEC_FAST = "0";
    const p = copilotTurn({ user: USER, message: "Give me the KPI overview", signal: ctrl.signal, emit: (x) => { parts.push(x); if (x.type === "text" && parts.filter((q) => q.type === "text").length === 3) ctrl.abort(); } });
    const cid = await p; process.env.AEC_FAST = "1";
    expect(one<{ status: string }>("SELECT status FROM copilot_messages WHERE conversation_id = ? AND role = 'assistant'", cid)!.status).toBe("cancelled");
  });
});
