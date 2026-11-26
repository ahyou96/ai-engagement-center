import { all, db, J, one } from "./db";
import { nowDate, nowIso } from "./util";

/**
 * Mandatory compliance enforcement layer.
 * Every send (messaging.ts) and every entitlement issuance (offers.ts) calls `evaluate` internally —
 * there is no code path that writes a message or an offer transaction without it, and AI agents
 * only ever reach those paths through the same functions.
 */
export type Purpose = "service" | "security" | "regulatory" | "protective" | "operational" | "membership" | "marketing" | "regulated_promotion";
export const PROMOTIONAL: Purpose[] = ["membership", "marketing", "regulated_promotion"];
export const PROTECTED_PURPOSES: Purpose[] = ["service", "security", "regulatory", "protective", "operational"];
export const isPromotional = (p: string) => PROMOTIONAL.includes(p as Purpose);

export type Reason = { policy: string; message: string };
export type PlayerCheck = { player_id: string; allowed: boolean; reasons: Reason[] };

type Policy = { key: string; enabled: number; mandatory: number; config: string };
export function policies(): Record<string, { enabled: boolean; mandatory: boolean; config: Record<string, unknown> }> {
  const out: Record<string, { enabled: boolean; mandatory: boolean; config: Record<string, unknown> }> = {};
  for (const p of all<Policy>("SELECT key, enabled, mandatory, config FROM compliance_policies")) {
    // mandatory policies cannot be disabled — enforced here regardless of the stored flag
    out[p.key] = { enabled: p.mandatory ? true : !!p.enabled, mandatory: !!p.mandatory, config: J.parse(p.config, {}) };
  }
  return out;
}

export function emergencyStopActive(): boolean {
  return one<{ value: string }>("SELECT value FROM settings WHERE key = 'emergency_stop'")?.value === "true";
}

type Cust = {
  player_id: string; age: number | null; kyc_status: string; self_excluded: number; rg_restricted: number;
  marketing_opt_out: number; account_status: string;
};

export function evaluate(params: { playerIds: string[]; purpose: Purpose | string; channel?: string | null; action: "message" | "offer" | "targeting"; at?: Date; context?: string; refId?: string; log?: boolean }): PlayerCheck[] {
  const { playerIds, purpose, channel, action } = params;
  if (!playerIds.length) return [];
  const pol = policies();
  const promo = isPromotional(purpose);
  const at = params.at ?? nowDate();
  const results: PlayerCheck[] = [];
  const estop = emergencyStopActive();

  const chunks: string[][] = [];
  for (let i = 0; i < playerIds.length; i += 500) chunks.push(playerIds.slice(i, i + 500));

  for (const chunk of chunks) {
    const ph = chunk.map(() => "?").join(",");
    const custs = new Map(all<Cust>(`SELECT player_id, age, kyc_status, self_excluded, rg_restricted, marketing_opt_out, account_status FROM customers WHERE player_id IN (${ph})`, ...chunk).map((c) => [c.player_id, c]));
    const activeExcl = new Map<string, string[]>();
    for (const r of all<{ player_id: string; exclusion_type: string }>(`SELECT player_id, exclusion_type FROM exclusion_records WHERE active = 1 AND player_id IN (${ph})`, ...chunk)) {
      activeExcl.set(r.player_id, [...(activeExcl.get(r.player_id) ?? []), r.exclusion_type]);
    }
    const consentChannel = channel ? (one<{ consent_channel: string }>("SELECT consent_channel FROM channels WHERE key = ?", channel)?.consent_channel ?? channel) : null;
    const consentPurpose = promo ? "marketing" : "service";
    const consent = new Map<string, number>();
    if (consentChannel) {
      for (const r of all<{ player_id: string; granted: number }>(`SELECT player_id, granted FROM consent_current WHERE channel = ? AND purpose = ? AND player_id IN (${ph})`, consentChannel, consentPurpose, ...chunk)) consent.set(r.player_id, r.granted);
    }
    const freq = new Map<string, { d: number; w: number }>();
    if (promo && action === "message" && pol.frequency_cap?.enabled) {
      const dayAgo = new Date(at.getTime() - 86400_000).toISOString();
      const weekAgo = new Date(at.getTime() - 7 * 86400_000).toISOString();
      for (const r of all<{ player_id: string; d: number; w: number }>(
        `SELECT player_id, SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) d, COUNT(*) w FROM messages WHERE player_id IN (${ph}) AND purpose IN ('membership','marketing','regulated_promotion') AND status NOT IN ('cancelled','rejected','blocked') AND created_at > ? GROUP BY player_id`,
        dayAgo, weekAgo, ...chunk)) freq.set(r.player_id, { d: r.d, w: r.w });
    }

    for (const pid of chunk) {
      const c = custs.get(pid);
      const reasons: Reason[] = [];
      if (!c) { results.push({ player_id: pid, allowed: false, reasons: [{ policy: "unknown_player", message: "Player not found" }] }); continue; }
      const excl = activeExcl.get(pid) ?? [];
      if (estop && purpose !== "protective" && purpose !== "security" && purpose !== "regulatory")
        reasons.push({ policy: "emergency_stop", message: "Global emergency stop is active" });
      if (c.account_status === "closed") reasons.push({ policy: "account_restriction", message: "Account closed" });
      if (promo) {
        const minAge = Number(pol.age_eligibility?.config.min_age ?? 21);
        if (pol.age_eligibility?.enabled && (c.age == null || c.age < minAge)) reasons.push({ policy: "age_eligibility", message: `Age below ${minAge} or unknown` });
        if (pol.kyc_required?.enabled && c.kyc_status !== "verified") reasons.push({ policy: "kyc_required", message: `KYC status ${c.kyc_status}` });
        if (pol.self_exclusion?.enabled && (c.self_excluded || excl.includes("self_exclusion"))) reasons.push({ policy: "self_exclusion", message: "Player is self-excluded" });
        if (pol.responsible_gaming?.enabled && (c.rg_restricted || excl.includes("rg_restriction"))) reasons.push({ policy: "responsible_gaming", message: "Responsible gaming restriction active" });
        if (pol.marketing_opt_out?.enabled && (c.marketing_opt_out || excl.includes("marketing_opt_out"))) reasons.push({ policy: "marketing_opt_out", message: "Player opted out of marketing" });
        if (c.account_status === "suspended" || excl.includes("account_restriction")) reasons.push({ policy: "account_restriction", message: "Account restricted" });
        if (action === "message" && pol.frequency_cap?.enabled) {
          const f = freq.get(pid) ?? { d: 0, w: 0 };
          const perDay = Number(pol.frequency_cap.config.per_day ?? 2), perWeek = Number(pol.frequency_cap.config.per_week ?? 5);
          if (f.d >= perDay) reasons.push({ policy: "frequency_cap", message: `Daily cap ${perDay} reached` });
          else if (f.w >= perWeek) reasons.push({ policy: "frequency_cap", message: `Weekly cap ${perWeek} reached` });
        }
        if (action === "message" && pol.quiet_hours?.enabled) {
          const tzOffset = Number(pol.quiet_hours.config.utc_offset_hours ?? 8);
          const h = (at.getUTCHours() + tzOffset + 24) % 24;
          const s = Number(pol.quiet_hours.config.start_hour ?? 22), e = Number(pol.quiet_hours.config.end_hour ?? 8);
          if (s > e ? h >= s || h < e : h >= s && h < e) reasons.push({ policy: "quiet_hours", message: `Quiet hours ${s}:00–${e}:00 local` });
        }
      }
      if (action === "message" && consentChannel && pol.channel_consent?.enabled) {
        const g = consent.get(pid);
        if (g !== 1) reasons.push({ policy: "channel_consent", message: `No ${consentPurpose} consent for ${consentChannel}` });
      }
      results.push({ player_id: pid, allowed: reasons.length === 0, reasons });
    }
  }

  if (params.log !== false) {
    const ins = db().prepare("INSERT INTO compliance_checks (context, ref_id, player_id, purpose, channel, allowed, reasons, at) VALUES (?,?,?,?,?,?,?,?)");
    const t = nowIso();
    const blocked = results.filter((r) => !r.allowed);
    db().transaction(() => {
      ins.run(params.context ?? action, params.refId ?? null, null, purpose, channel ?? null, blocked.length === 0 ? 1 : 0, J.str({ total: results.length, blocked: blocked.length, by_policy: summarize(results) }), t);
      for (const b of blocked.slice(0, 200)) ins.run(params.context ?? action, params.refId ?? null, b.player_id, purpose, channel ?? null, 0, J.str(b.reasons), t);
    })();
  }
  return results;
}

export function summarize(results: PlayerCheck[]) {
  const by: Record<string, number> = {};
  for (const r of results) for (const x of r.reasons) by[x.policy] = (by[x.policy] ?? 0) + 1;
  return by;
}

/** Validate message content against prohibited promotional language for vulnerable/service contexts. */
const PROHIBITED = [/chase (your )?loss/i, /win back/i, /recover (your )?loss/i, /guaranteed win/i, /risk[- ]free bet/i, /bet more/i, /don'?t stop/i];
export function validateContent(body: string, purpose: string): Reason[] {
  const out: Reason[] = [];
  for (const re of PROHIBITED) if (re.test(body)) out.push({ policy: "content_standards", message: `Prohibited phrase: ${re.source}` });
  if (!isPromotional(purpose) && /bonus|free spins|deposit match/i.test(body)) out.push({ policy: "purpose_mismatch", message: "Service/operational message contains promotional incentive language" });
  if (isPromotional(purpose) && !/responsib|21\+|play responsibly|opt.?out|unsubscribe|STOP/i.test(body)) out.push({ policy: "rg_disclaimer", message: "Promotional content requires a responsible gaming / opt-out notice" });
  return out;
}
