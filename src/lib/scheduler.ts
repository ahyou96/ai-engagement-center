import { all, J, one, run } from "./db";
import { recoverRuns, startRun } from "./workflow/engine";
import { processDue } from "./journeys";
import { expireApprovals } from "./approvals";
import { evaluateSegment } from "./segments";
import { SYSTEM } from "./audit";
import { nowIso } from "./util";

/**
 * In-process background jobs (single-node first release): workflow recovery on boot, journey waits,
 * approval expiry, scheduled workflow runs, scheduled segment refresh. See docs/ARCHITECTURE.md for the
 * production plan (dedicated worker + durable queue).
 */
const g = globalThis as unknown as { __aecBg?: boolean };
export function ensureBackground() {
  if (g.__aecBg || process.env.AEC_DISABLE_BACKGROUND === "1") return;
  g.__aecBg = true;
  try { const n = recoverRuns(); if (n) console.log(`[aec] recovered ${n} workflow run(s) after restart`); } catch (e) { console.error("[aec] recovery failed", e); }
  let tick = 0;
  setInterval(() => {
    tick++;
    try {
      processDue();
      expireApprovals();
      const sched = J.parse<Array<{ id: string; scenario: string; mode: "manual" | "auto"; simulation: boolean; due: string; by: string }>>(one<{ value: string }>("SELECT value FROM settings WHERE key = 'scheduled_runs'")?.value, []);
      const due = sched.filter((s) => s.due <= nowIso());
      if (due.length) {
        run("UPDATE settings SET value = ? WHERE key = 'scheduled_runs'", J.str(sched.filter((s) => s.due > nowIso())));
        for (const s of due) { try { startRun({ scenario: s.scenario, mode: s.mode, simulation: s.simulation, trigger: "scheduled", actor: { type: "user", id: s.by } }); } catch (e) { console.error("[aec] scheduled run failed", e); } }
      }
      if (tick % 20 === 0) for (const s of all<{ id: string }>("SELECT id FROM segments WHERE status = 'active' AND segment_type IN ('dynamic','realtime')")) evaluateSegment(s.id, SYSTEM, "scheduled_refresh");
    } catch (e) { console.error("[aec] background tick failed", e); }
  }, 30_000).unref?.();
}
