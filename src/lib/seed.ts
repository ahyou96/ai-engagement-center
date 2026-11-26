import fs from "node:fs";
import crypto from "node:crypto";
import { db, J, useDatabase, run, all, one } from "./db";
import { hashPassword } from "./auth";
import { ROLES } from "./rbac";
import { DEFAULT_CONFIGS } from "./strategy";
import { evaluateSegment, Rule } from "./segments";
import { prng, ORG_ID, hashStable } from "./util";
import { AGENTS, WORKFLOWS } from "./workflow/definitions";
import { audit, SYSTEM } from "./audit";

/**
 * Deterministic synthetic data generator. All names/identifiers are synthetic.
 * Everything downstream (dashboards, segments, offers, workflows) is derived from these shared tables.
 */
export const isPublic = () => process.env.AEC_PUBLIC === "1";
export type SeedOptions = { file?: string; customers?: number; events?: number; seed?: number; quiet?: boolean };

const FIRST = ["Andrea", "Benjo", "Carla", "Dindo", "Ella", "Ferdie", "Gina", "Hector", "Isa", "Jomar", "Kaye", "Lito", "Mika", "Nonoy", "Olive", "Paolo", "Queenie", "Rafa", "Sol", "Tonyo", "Uma", "Vince", "Wena", "Xian", "Yuri", "Zara", "Bea", "Carlo", "Dana", "Enzo"];
const LAST = ["Abad", "Bautista", "Cruz", "Dizon", "Estrada", "Flores", "Garcia", "Hernandez", "Ignacio", "Jimenez", "Katigbak", "Lim", "Mendoza", "Navarro", "Ocampo", "Pascual", "Quinto", "Reyes", "Santos", "Tan", "Uy", "Villanueva", "Wong", "Yap", "Zamora"];
const CITIES = ["Manila", "Quezon City", "Cebu City", "Davao City", "Makati", "Pasig", "Taguig", "Iloilo City", "Baguio", "Cagayan de Oro", "Bacolod", "Angeles"];
const PROVIDERS = ["Aurora Gaming", "Bluepeak Studios", "Nebula Play", "Coral Reef Games", "Ironwood Interactive", "Lumen Live", "Mango Tree Gaming", "Northstar Labs", "Orchid Entertainment", "Pinecone Digital", "Quartz Arcade", "Riverstone Play", "Saffron Studios", "Tidewater Games", "Umbra Interactive", "Velvet Dice", "Willow Works", "Xenon Arcade", "Yellowfin Games", "Zephyr Live"];
const CATS = ["slots", "live_casino", "table", "fishing", "crash", "bingo", "sports"] as const;
const GAME_WORDS = ["Golden", "Dragon", "Lucky", "Fortune", "Jungle", "Ocean", "Mystic", "Royal", "Thunder", "Jade", "Phoenix", "Treasure", "Island", "Fiesta", "Carnival", "Sakura", "Tiger", "Pearl", "Volcano", "Comet"];
const GAME_NOUNS = ["Quest", "Reels", "Rush", "Palace", "Spin", "Hunt", "Party", "Legends", "Blitz", "Fever", "Riches", "Voyage"];
export const CHANNEL_DEFS = [
  { key: "sms", name: "SMS", provider: "Mock SMS Gateway", cost: 0.45, consent: "sms", cfg: { mock_delivery_rate: 0.74, mock_read_rate: 0.3, mock_click_rate: 0.05, mock_send_failure_rate: 0.04 } },
  { key: "email", name: "Email", provider: "Mock ESP", cost: 0.02, consent: "email", cfg: { mock_delivery_rate: 0.97, mock_read_rate: 0.32, mock_click_rate: 0.06 } },
  { key: "app_push", name: "App Push", provider: "Mock FCM/APNs", cost: 0.001, consent: "app_push", cfg: { mock_delivery_rate: 0.92, mock_read_rate: 0.22, mock_click_rate: 0.08 } },
  { key: "web_push", name: "Web Push", provider: "Mock Web Push", cost: 0.001, consent: "web_push", cfg: { mock_delivery_rate: 0.88, mock_read_rate: 0.12, mock_click_rate: 0.04 } },
  { key: "inbox", name: "In-App Inbox", provider: "Native", cost: 0, consent: "inbox", cfg: { mock_delivery_rate: 0.995, mock_read_rate: 0.55, mock_click_rate: 0.12 } },
  { key: "h5_pc_notice", name: "H5/PC Notifications", provider: "Native", cost: 0, consent: "inbox", cfg: { mock_delivery_rate: 0.99, mock_read_rate: 0.4, mock_click_rate: 0.08 } },
  { key: "viber", name: "Viber", provider: "Mock Viber Business", cost: 0.18, consent: "viber", cfg: { mock_delivery_rate: 0.95, mock_read_rate: 0.6, mock_click_rate: 0.1 } },
  { key: "whatsapp", name: "WhatsApp", provider: "Mock WhatsApp Cloud", cost: 0.35, consent: "whatsapp", cfg: { mock_delivery_rate: 0.96, mock_read_rate: 0.7, mock_click_rate: 0.12 } },
  { key: "messenger", name: "Messenger", provider: "Mock Messenger", cost: 0.05, consent: "messenger", cfg: { mock_delivery_rate: 0.9, mock_read_rate: 0.5, mock_click_rate: 0.08 } },
  { key: "telegram", name: "Telegram", provider: "Mock Telegram Bot", cost: 0.0, consent: "telegram", cfg: { mock_delivery_rate: 0.97, mock_read_rate: 0.5, mock_click_rate: 0.07 } },
];
export const EVENT_DICTIONARY: Array<[string, string, string, string[], boolean?]> = [
  ["game_impression", "discovery", "Game tile rendered to the player", ["player_id", "game_id"]],
  ["game_click", "discovery", "Player clicked a game tile", ["player_id", "game_id"]],
  ["game_search", "discovery", "Search performed", ["player_id"]],
  ["game_search_no_result", "discovery", "Search returned no results", ["player_id"]],
  ["game_favorite_add", "preference", "Game added to favourites", ["player_id", "game_id"]],
  ["game_favorite_remove", "preference", "Game removed from favourites", ["player_id", "game_id"]],
  ["game_launch_start", "experience", "Game launch initiated", ["player_id", "game_id", "provider_id"]],
  ["game_launch_success", "experience", "Game launched successfully", ["player_id", "game_id", "provider_id"]],
  ["game_launch_failed", "experience", "Game launch failed", ["player_id", "game_id", "provider_id"]],
  ["game_session_start", "behavior", "Game session started", ["player_id", "game_id", "session_id"]],
  ["game_session_end", "behavior", "Game session ended", ["player_id", "game_id", "session_id"]],
  ["game_switch", "behavior", "Switched between games", ["player_id", "game_id"]],
  ["game_disconnect", "experience", "Game disconnected", ["player_id", "game_id"]],
  ["game_error", "experience", "In-game error", ["player_id", "game_id"]],
  ["game_bet_placed", "gaming_transaction", "Restricted: bet placed", ["player_id", "game_id"], true],
  ["game_bet_settled", "gaming_transaction", "Restricted: bet settled", ["player_id", "game_id"], true],
  ["game_topup_click", "behavior", "Top-up clicked from game", ["player_id"]],
  ["game_cs_click", "service", "Customer service clicked in game", ["player_id"]],
  ["game_exit", "behavior", "Exited game", ["player_id", "game_id"]],
  ["gaming_limit_reached", "responsible_gaming", "Player reached a configured gaming limit", ["player_id"]],
  ["self_exclusion_enabled", "responsible_gaming", "Player enabled self-exclusion", ["player_id"]],
  ["kyc_submitted", "kyc", "KYC documents submitted", ["player_id"]],
  ["kyc_verified", "kyc", "KYC verified", ["player_id"]],
  ["kyc_failed", "kyc", "KYC failed", ["player_id"]],
  ["login", "account", "Player login", ["player_id"]],
];

export function seed(opts: SeedOptions = {}) {
  const N = opts.customers ?? Number(process.env.AEC_SEED_CUSTOMERS ?? 10000);
  const EV = opts.events ?? Number(process.env.AEC_SEED_EVENTS ?? 100000);
  const R = prng(opts.seed ?? Number(process.env.AEC_SEED ?? 42));
  if (opts.file) { for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(opts.file + ext); } catch { /* none */ } } useDatabase(opts.file); }
  const d = db();
  const log = (m: string) => { if (!opts.quiet) console.log(`[seed] ${m}`); };
  const NOW = Date.now();
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const H = 3600_000, D = 86400_000;
  const ins = (sql: string) => d.prepare(sql);
  const T = iso(0);

  d.transaction(() => {
    run("INSERT INTO organizations (id, name, created_at) VALUES (?,?,?)", ORG_ID, "Demo Gaming Group (synthetic)", T);
    run("INSERT INTO system_clock (id, offset_minutes) VALUES (1, 0)");
    for (const [rid, r] of Object.entries(ROLES)) { run("INSERT INTO roles (id, name, description) VALUES (?,?,?)", rid, r.name, r.description); for (const p of r.permissions) run("INSERT INTO permissions (role_id, permission) VALUES (?,?)", rid, p); }
    const users: Array<[string, string, string]> = [["admin@aec.local", "Alex Admin", "admin"], ["ops@aec.local", "Olivia Ops", "ops_manager"], ["crm@aec.local", "Marco CRM", "marketer"], ["analyst@aec.local", "Ana Analyst", "analyst"], ["cs@aec.local", "Cris Service", "cs_agent"], ["compliance@aec.local", "Connie Compliance", "compliance_officer"], ["finance@aec.local", "Fe Finance", "finance"]];
    // Public deployments (AEC_PUBLIC=1) never use the demo password: AEC_DEMO_PASSWORD (a host secret) or a random one printed once.
    let plain = "demo1234";
    if (isPublic()) {
      plain = process.env.AEC_DEMO_PASSWORD ?? crypto.randomBytes(12).toString("base64url");
      if (plain.length < 12) throw new Error("AEC_DEMO_PASSWORD must be at least 12 characters");
      if (!process.env.AEC_DEMO_PASSWORD) console.log(`[seed] PUBLIC MODE: generated password for all accounts (shown once): ${plain}`);
    }
    const pw = hashPassword(plain);
    for (const [e, n, r] of users) run("INSERT INTO users (id, org_id, email, name, password_hash, role_id, created_at) VALUES (?,?,?,?,?,?,?)", `usr_${r}`, ORG_ID, e, n, pw, r, T);

    // providers & games
    PROVIDERS.forEach((p, i) => run("INSERT INTO gaming_providers (id, name, region, status, integration_type, sla_launch_success, created_at) VALUES (?,?,?,?,?,?,?)", `prv_${String(i + 1).padStart(2, "0")}`, p, R.pick(["APAC", "EU", "Global"]), "operational", R.pick(["iframe", "api", "lobby"]), 0.98, T));
    for (let i = 0; i < 200; i++) {
      const cat = CATS[i % CATS.length === 6 ? (R.chance(0.5) ? 0 : 6) : i % CATS.length];
      run("INSERT INTO games (id, provider_id, name, category, status, released_at, popularity) VALUES (?,?,?,?,?,?,?)", `gm_${String(i + 1).padStart(3, "0")}`, `prv_${String((i % 20) + 1).padStart(2, "0")}`, `${R.pick(GAME_WORDS)} ${R.pick(GAME_NOUNS)} ${i + 1}`, cat, "live", iso(R.int(30, 900) * D), Math.round(R.next() * 1000) / 10);
    }
    // event dictionary
    for (const [n, c, desc, req, restricted] of EVENT_DICTIONARY) run("INSERT INTO event_definitions (name, category, description, version, required_attributes, restricted, enabled, updated_at) VALUES (?,?,?,?,?,?,1,?)", n, c, desc, 1, J.str(req), restricted ? 1 : 0, T);
    // channels
    for (const c of CHANNEL_DEFS) run("INSERT INTO channels (key, name, provider, mode, connection_status, cost_per_message, retry_policy, fallback_channels, consent_channel, restrictions, health, enabled, config) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      c.key, c.name, c.provider, "mock", "mock_verified", c.cost, J.str({ max_attempts: 3, backoff_seconds: [30, 120, 600] }), J.str(c.key === "sms" ? ["viber", "inbox"] : ["inbox"]), c.consent,
      c.key === "whatsapp" ? "Template pre-approval required; 24h session window" : c.key === "sms" ? "Sender ID registration; no promotional SMS during quiet hours" : null, c.key === "sms" ? "degraded" : "healthy", 1, J.str(c.cfg));
  })();
  log("reference data");

  // ───── customers ─────
  const players: Array<{ id: string; reg: number; plat: string; os: string; kyc: string; app: boolean; excl: boolean; rg: boolean; optout: boolean; age: number; tier: string; lastActiveAgo: number }> = [];
  const insC = ins(`INSERT INTO customers (player_id, org_id, display_name, email, phone, birth_date, age, gender, country, city, language, registered_at, lifecycle_stage, kyc_status, kyc_updated_at, kyc_failure_reason, vip_tier, primary_platform, device_type, os, app_version,
    last_active_at, last_login_at, account_status, risk_level, self_excluded, rg_restricted, marketing_opt_out, deposit_count, deposit_total, withdrawal_total, gaming_sessions_30d, gaming_active_days_30d, avg_session_minutes, favorite_category, favorite_provider_id, open_tickets, tickets_30d, csat, first_game_at, last_game_at, profile_completeness, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insI = ins("INSERT OR IGNORE INTO customer_identities (id, org_id, player_id, identity_type, identity_value, verified, confidence, source, created_at) VALUES (?,?,?,?,?,?,?,?,?)");
  const insCons = ins("INSERT INTO consent_current (player_id, channel, purpose, granted, updated_at) VALUES (?,?,?,?,?)");
  const insConsRec = ins("INSERT INTO consent_records (player_id, channel, purpose, granted, source, recorded_at) VALUES (?,?,?,?,?,?)");
  const insEx = ins("INSERT INTO exclusion_records (id, player_id, exclusion_type, reason, source, active, created_at) VALUES (?,?,?,?,?,1,?)");
  d.transaction(() => {
    for (let i = 0; i < N; i++) {
      const pid = `P${String(100000 + i)}`;
      const first = R.pick(FIRST), last = R.pick(LAST);
      const regAgo = R.int(1, 1100) * D + R.int(0, 86000) * 1000;
      const lastActiveAgo = Math.min(regAgo, R.weighted([[R.int(0, 2) * D + R.int(0, 80000) * 1000, 45], [R.int(3, 14) * D, 25], [R.int(15, 60) * D, 18], [R.int(61, 400) * D, 12]] as const));
      const age = R.weighted([[R.int(18, 20), 4], [R.int(21, 30), 38], [R.int(31, 45), 38], [R.int(46, 70), 20]] as const);
      const plat = R.weighted([["app", 52], ["h5", 33], ["pc", 15]] as const);
      const os = plat === "pc" ? R.weighted([["windows", 85], ["macos", 15]] as const) : R.weighted([["android", 72], ["ios", 28]] as const);
      let kyc = R.weighted([["verified", 70], ["pending", 9], ["in_review", 5], ["failed", 8], ["not_started", 8]] as const) as string;
      if (regAgo < 3 * D && kyc === "verified") kyc = "pending";
      const kycUpd = kyc === "not_started" ? null : iso(Math.min(regAgo, R.int(1, 240) * H));
      const tenureDays = regAgo / D;
      const tier = R.weighted([["standard", 55], ["bronze", 20], ["silver", 13], ["gold", 8], ["platinum", 4]] as const);
      const stage = regAgo < 7 * D ? "new" : lastActiveAgo < 3 * D ? (R.chance(0.5) ? "engaged" : "active") : lastActiveAgo < 15 * D ? "active" : lastActiveAgo < 45 * D ? "at_risk" : lastActiveAgo < 120 * D ? "dormant" : "churned";
      const excl = R.chance(0.015), rg = !excl && R.chance(0.01), optout = R.chance(0.08);
      const status = R.chance(0.006) ? "suspended" : R.chance(0.003) ? "closed" : "active";
      const fav = R.pick(CATS);
      const sessions = lastActiveAgo < 30 * D ? R.int(1, 60) : 0;
      const completeness = Math.round((0.5 + R.next() * 0.5) * 100) / 100;
      insC.run(pid, ORG_ID, `${first} ${last}`, `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.test`, `+6391${String(7000000 + i).padStart(8, "0")}`, new Date(NOW - age * 365.25 * D - R.int(0, 360) * D).toISOString().slice(0, 10), age, R.pick(["f", "m", "x"]), "PH", R.pick(CITIES), R.weighted([["en", 50], ["fil", 40], ["zh", 10]] as const), iso(regAgo), stage,
        kyc, kycUpd, kyc === "failed" ? R.weighted([["blurry_document", 45], ["name_mismatch", 25], ["expired_id", 15], ["selfie_mismatch", 15]] as const) : null, tier, plat, plat === "pc" ? "desktop" : R.chance(0.08) ? "tablet" : "mobile", os, plat === "app" ? R.pick(["5.2.0", "5.3.1", "5.4.0"]) : null,
        iso(lastActiveAgo), iso(lastActiveAgo + R.int(0, 3) * H), status, R.weighted([["low", 85], ["medium", 12], ["high", 3]] as const), excl ? 1 : 0, rg ? 1 : 0, optout ? 1 : 0,
        R.int(0, 80), Math.round(R.next() * 80000), Math.round(R.next() * 50000), sessions, Math.min(30, Math.ceil(sessions / 2)), Math.round(5 + R.next() * 40), fav, `prv_${String(R.int(1, 20)).padStart(2, "0")}`, 0, 0, R.chance(0.3) ? Math.round((3 + R.next() * 2) * 10) / 10 : null,
        sessions ? iso(regAgo - R.int(0, 2) * D) : null, sessions ? iso(lastActiveAgo) : null, completeness, T);
      // identities (verified)
      insI.run(`idn_${pid}_pid`, ORG_ID, pid, "player_id", pid, 1, 1, "core", iso(regAgo));
      insI.run(`idn_${pid}_em`, ORG_ID, pid, "email", `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.test`, R.chance(0.85) ? 1 : 0, 1, "registration", iso(regAgo));
      insI.run(`idn_${pid}_ph`, ORG_ID, pid, "phone", `+6391${String(7000000 + i).padStart(8, "0")}`, 1, 1, "otp", iso(regAgo));
      if (plat === "app" || R.chance(0.3)) insI.run(`idn_${pid}_app`, ORG_ID, pid, "app_device", `app-${hashStable(pid).slice(0, 12)}`, 1, 1, "app_login", iso(regAgo));
      if (plat === "h5" || R.chance(0.4)) insI.run(`idn_${pid}_h5`, ORG_ID, pid, "h5_cookie", `h5-${hashStable(pid + "h5").slice(0, 12)}`, 1, 1, "h5_login", iso(regAgo));
      if (plat === "pc" || R.chance(0.2)) insI.run(`idn_${pid}_pc`, ORG_ID, pid, "pc_cookie", `pc-${hashStable(pid + "pc").slice(0, 12)}`, 1, 1, "pc_login", iso(regAgo));
      if (R.chance(0.35)) insI.run(`idn_${pid}_vb`, ORG_ID, pid, "viber", `vb-${hashStable(pid + "vb").slice(0, 10)}`, 1, 1, "viber_optin", iso(regAgo));
      if (R.chance(0.25)) insI.run(`idn_${pid}_wa`, ORG_ID, pid, "whatsapp", `wa-${hashStable(pid + "wa").slice(0, 10)}`, 1, 1, "whatsapp_optin", iso(regAgo));
      if (R.chance(0.3)) insI.run(`idn_${pid}_ms`, ORG_ID, pid, "messenger", `ms-${hashStable(pid + "ms").slice(0, 10)}`, 1, 1, "messenger_optin", iso(regAgo));
      if (R.chance(0.15)) insI.run(`idn_${pid}_sso`, ORG_ID, pid, "sso", `sso-${hashStable(pid + "sso").slice(0, 10)}`, 1, 1, "sso", iso(regAgo));
      // consent
      const app = plat === "app" || R.chance(0.3);
      const svc: Record<string, boolean> = { sms: R.chance(0.92), email: R.chance(0.8), app_push: app && R.chance(0.85), web_push: R.chance(0.3), inbox: true, viber: R.chance(0.35), whatsapp: R.chance(0.25), messenger: R.chance(0.3), telegram: R.chance(0.1) };
      for (const [ch, g] of Object.entries(svc)) {
        insCons.run(pid, ch, "service", g ? 1 : 0, iso(regAgo));
        const mk = g && !optout && R.chance(0.65);
        insCons.run(pid, ch, "marketing", mk ? 1 : 0, iso(regAgo));
        if (i < 500) insConsRec.run(pid, ch, "marketing", mk ? 1 : 0, "registration", iso(regAgo));
      }
      if (excl) insEx.run(`exc_${pid}`, pid, "self_exclusion", "Player-initiated self-exclusion", "player_settings", iso(R.int(1, 200) * D));
      if (rg) insEx.run(`exc_${pid}`, pid, "rg_restriction", "Deposit limit breach review", "rg_team", iso(R.int(1, 100) * D));
      if (optout) insEx.run(`exc_${pid}_mo`, pid, "marketing_opt_out", "Unsubscribed", "player", iso(R.int(1, 300) * D));
      players.push({ id: pid, reg: regAgo, plat, os, kyc, app, excl, rg, optout, age, tier, lastActiveAgo });
    }
    // uncertain identity matches → review queue (never auto-merged)
    for (let k = 0; k < 30; k++) {
      const a = players[R.int(0, N - 1)].id, b = players[R.int(0, N - 1)].id;
      run("INSERT INTO identity_merge_candidates (id, org_id, identity_type, identity_value, candidate_player_id, matched_player_id, match_reason, confidence, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        `imc_${k}`, ORG_ID, R.pick(["email", "phone", "messenger"]), `shared-${k}@example.test`, a, b, R.pick(["same device fingerprint", "similar name + city", "shared phone in CS ticket"]), Math.round((0.55 + R.next() * 0.35) * 100) / 100, "pending", iso(R.int(1, 20) * D));
    }
  })();
  log(`${N} customers`);

  // ───── events, sessions, transactions ─────
  const games = all<{ id: string; provider_id: string; category: string }>("SELECT id, provider_id, category FROM games");
  const insE = ins(`INSERT INTO events (event_id, org_id, event_name, category, schema_version, player_id, game_id, provider_id, session_id, event_time, entry_source, platform, device_type, operating_system, app_version, loading_duration, error_code, correlation_id, properties, source, ingested_at) VALUES (?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insS = ins("INSERT INTO gaming_sessions (id, player_id, game_id, provider_id, platform, started_at, ended_at, duration_minutes, end_reason) VALUES (?,?,?,?,?,?,?,?,?)");
  const insTx = ins("INSERT INTO gaming_transactions (id, player_id, game_id, provider_id, session_id, bet_amount, payout, settled_at) VALUES (?,?,?,?,?,?,?,?)");
  const catOf: Record<string, string> = Object.fromEntries(EVENT_DICTIONARY.map((e) => [e[0], e[1]]));
  const active = players.filter((p) => p.lastActiveAgo < 30 * D && !p.excl);
  const INCIDENT_PROVIDER = "prv_03"; // Nebula Play: launch failures spike in the last ~6h
  const incidentGames = games.filter((g) => g.provider_id === INCIDENT_PROVIDER);
  let evn = 0, sess = 0, txn = 0;
  const KEYWORDS = ["dragon", "fortune", "fishing", "baccarat", "roulette", "sabong", "tongits", "jackpot", "mahjong", "crash"];
  d.transaction(() => {
    const add = (name: string, p: typeof players[number], at: number, extra: Partial<{ game: string; prov: string; sess: string; entry: string; load: number; err: string; props: unknown }> = {}) => {
      if (evn >= EV) return;
      evn++;
      insE.run(`evt_${evn}_${hashStable(p.id + evn).slice(0, 6)}`, ORG_ID, name, catOf[name] ?? "behavior", p.id, extra.game ?? null, extra.prov ?? null, extra.sess ?? null, iso(at), extra.entry ?? null, p.plat, p.plat === "pc" ? "desktop" : "mobile", p.os,
        p.plat === "app" ? "5.4.0" : null, extra.load ?? null, extra.err ?? null, null, J.str(extra.props ?? {}), "seed", iso(at));
    };
    // incident: ~1/5 of event budget around the incident provider in last 6 hours (high failure, timeouts)
    const incidentBudget = Math.floor(EV * 0.06);
    const pool = active.slice(0, Math.max(50, Math.floor(active.length * 0.12)));
    for (let k = 0; k < incidentBudget; k++) {
      const p = pool[R.int(0, pool.length - 1)], g = incidentGames[R.int(0, incidentGames.length - 1)];
      const at = R.int(0, 6 * 3600) * 1000;
      const progress = 1 - at / (6 * H); // failure rate rises over the window
      const fail = R.chance(0.03 + 0.5 * progress * progress);
      add("game_click", p, at + 1500, { game: g.id, prov: g.provider_id, entry: "homepage" });
      add("game_launch_start", p, at + 1000, { game: g.id, prov: g.provider_id, entry: "homepage" });
      add(fail ? "game_launch_failed" : "game_launch_success", p, at, { game: g.id, prov: g.provider_id, load: fail ? R.int(8000, 30000) : R.int(1500, 5000), err: fail ? R.weighted([["PROVIDER_TIMEOUT", 70], ["GATEWAY_502", 20], ["SESSION_TOKEN_INVALID", 10]] as const) : undefined });
    }
    // background activity (failure rate ~3%), sessions & restricted transactions
    let guard = 0;
    while (evn < EV - 4000 && guard++ < EV * 2) {
      const p = active[R.int(0, active.length - 1)];
      const g = games[R.int(0, games.length - 1)];
      const at = R.int(Math.floor(p.lastActiveAgo / 1000), Math.floor(Math.max(p.lastActiveAgo, Math.min(p.reg, 30 * D)) / 1000)) * 1000;
      const entry = R.weighted([["homepage", 30], ["search", 15], ["recent_play", 18], ["popular", 12], ["recommended", 10], ["banner", 8], ["game_floor", 7]] as const);
      for (let k = R.int(1, 4); k > 0; k--) { const o = games[R.int(0, games.length - 1)]; add("game_impression", p, at + 5000 + k * 700, { game: o.id, prov: o.provider_id, entry }); }
      add("game_impression", p, at + 5000, { game: g.id, prov: g.provider_id, entry });
      add("game_click", p, at + 3000, { game: g.id, prov: g.provider_id, entry });
      if (entry === "search") { const kw = R.pick(KEYWORDS); const none = R.chance(0.12); add(none ? "game_search_no_result" : "game_search", p, at + 4000, { props: { keyword: none ? kw + "z" : kw, results: none ? 0 : R.int(1, 20) } }); }
      const slowOs = p.os === "ios" && g.provider_id === "prv_07";
      const fail = R.chance(slowOs ? 0.12 : 0.03);
      add("game_launch_start", p, at + 2000, { game: g.id, prov: g.provider_id, entry });
      add(fail ? "game_launch_failed" : "game_launch_success", p, at + 1000, { game: g.id, prov: g.provider_id, load: fail ? R.int(6000, 20000) : R.int(800, slowOs ? 9000 : 4500), err: fail ? R.weighted([["PROVIDER_TIMEOUT", 40], ["ASSET_LOAD_ERROR", 30], ["DEVICE_UNSUPPORTED", 15], ["GATEWAY_502", 15]] as const) : undefined });
      if (!fail) {
        const sid = `gs_${++sess}`; const dur = R.int(2, 75);
        add("game_session_start", p, at, { game: g.id, prov: g.provider_id, sess: sid });
        insS.run(sid, p.id, g.id, g.provider_id, p.plat, iso(at), iso(Math.max(0, at - dur * 60000)), dur, R.weighted([["normal", 88], ["disconnect", 6], ["error", 3], ["switch", 3]] as const));
        if (R.chance(0.5)) { const bet = R.int(1, 50) * 10; insTx.run(`gtx_${++txn}`, p.id, g.id, g.provider_id, sid, bet, R.chance(0.45) ? bet * R.int(0, 4) : 0, iso(Math.max(0, at - 60000))); }
        if (R.chance(0.04)) add("game_disconnect", p, Math.max(0, at - dur * 30000), { game: g.id, prov: g.provider_id, sess: sid });
        if (R.chance(0.02)) add("game_cs_click", p, Math.max(0, at - dur * 20000), { game: g.id });
        add("game_session_end", p, Math.max(0, at - dur * 60000), { game: g.id, prov: g.provider_id, sess: sid });
        if (R.chance(0.05)) add("game_favorite_add", p, Math.max(0, at - 1000), { game: g.id });
      }
    }
    // KYC & account events
    for (const p of players.slice(0, 3000)) {
      if (evn >= EV) break;
      if (p.kyc !== "not_started") add("kyc_submitted", p, Math.min(p.reg, 20 * D) - 3600_000 > 0 ? Math.min(p.reg, 20 * D) - 3600_000 : 0);
      if (p.kyc === "verified") add("kyc_verified", p, Math.max(0, Math.min(p.reg, 20 * D) - 7200_000));
      if (p.kyc === "failed") add("kyc_failed", p, Math.max(0, Math.min(p.reg, 20 * D) - 7200_000));
    }
    while (evn < EV) { const p = players[R.int(0, N - 1)]; add("login", p, p.lastActiveAgo); }
  })();
  log(`${evn} events, ${sess} sessions, ${txn} restricted transactions`);
  // aggregates from events (7d window)
  d.exec(`UPDATE customers SET
    launch_success_7d = (SELECT COUNT(*) FROM events e WHERE e.player_id = customers.player_id AND e.event_name = 'game_launch_success' AND e.event_time >= '${iso(7 * D)}'),
    launch_failures_7d = (SELECT COUNT(*) FROM events e WHERE e.player_id = customers.player_id AND e.event_name = 'game_launch_failed' AND e.event_time >= '${iso(7 * D)}'),
    avg_load_ms = COALESCE((SELECT CAST(AVG(loading_duration) AS INTEGER) FROM events e WHERE e.player_id = customers.player_id AND e.event_name IN ('game_launch_success','game_launch_failed')), 0),
    search_no_result_7d = (SELECT COUNT(*) FROM events e WHERE e.player_id = customers.player_id AND e.event_name = 'game_search_no_result' AND e.event_time >= '${iso(7 * D)}')`);

  // ───── service tickets ─────
  d.transaction(() => {
    const cats = ["game_loading", "kyc_help", "payment", "account", "promotion_question", "technical", "responsible_gaming"];
    for (let k = 0; k < Math.max(50, Math.floor(N * 0.15)); k++) {
      const p = players[R.int(0, N - 1)];
      const cat = p.kyc === "failed" && R.chance(0.5) ? "kyc_help" : R.pick(cats);
      const open = R.chance(0.22);
      const at = R.int(1, 60 * 24) * H;
      run("INSERT INTO service_tickets (id, player_id, category, subject, status, priority, source, created_at, resolved_at) VALUES (?,?,?,?,?,?,?,?,?)", `tkt_${k}`, p.id, cat, `${cat.replace("_", " ")} inquiry`, open ? R.pick(["open", "pending"]) : "resolved", R.pick(["low", "normal", "high"]), R.pick(["livechat", "email", "in_game", "phone"]), iso(at), open ? null : iso(Math.max(0, at - R.int(1, 48) * H)));
    }
    // incident-related open tickets
    for (const p of active.slice(0, 40)) run("INSERT INTO service_tickets (id, player_id, category, subject, status, priority, source, created_at) VALUES (?,?,?,?,?,?,?,?)", `tkt_inc_${p.id}`, p.id, "game_loading", "Game stuck on loading screen", "open", "high", "in_game", iso(R.int(0, 5) * H));
    d.exec(`UPDATE customers SET open_tickets = (SELECT COUNT(*) FROM service_tickets t WHERE t.player_id = customers.player_id AND t.status IN ('open','pending')),
      tickets_30d = (SELECT COUNT(*) FROM service_tickets t WHERE t.player_id = customers.player_id AND t.created_at >= '${iso(30 * D)}')`);
  })();

  // ───── tags ─────
  d.transaction(() => {
    const tags: Array<[string, string, string, string, string | null, number | null]> = [
      ["high_engagement", "High engagement", "computed", "gaming_sessions_30d >= 30", null, null], ["new_member", "New member", "system", "registered < 14d", null, null],
      ["vip_service", "VIP service", "manual", "Assigned by account managers", null, null], ["kyc_help_needed", "KYC help needed", "event", "kyc_failed event", null, 30],
      ["launch_issue_7d", "Launch issues (7d)", "computed", "launch_failures_7d >= 3", null, 7], ["search_friction", "Search friction", "computed", "search_no_result_7d >= 2", null, 7],
      ["rg_excluded", "RG excluded", "compliance", "Mandatory: self-exclusion / RG restriction", "Exclusion use only — never for targeting", null],
      ["marketing_opt_out", "Marketing opt-out", "compliance", "Unsubscribed from marketing", "Exclusion use only", null],
      ["cs_open_ticket", "Open CS ticket", "system", "open_tickets > 0", null, null], ["ios_slow_loader", "iOS slow loader", "ai_suggested", "AI-suggested: iOS + avg_load_ms > 5000", "Pending review", null],
      ["festival_campaign_2026", "Festival campaign 2026", "temporary", "Temporary campaign tag", null, 14], ["dormant_30d", "Dormant 30d", "computed", "last_active > 30d", null, null],
      ["prefers_live_casino", "Prefers live casino", "computed", "favorite_category = live_casino", null, null], ["prefers_slots", "Prefers slots", "computed", "favorite_category = slots", null, null],
      ["multi_platform", "Multi-platform", "computed", "≥2 verified platform identities", null, null], ["ticket_escalated", "Escalated ticket", "manual", "Escalated by CS", null, null],
      ["email_bounce", "Email bounced", "event", "Hard bounce received", null, null], ["app_user", "App user", "system", "primary_platform = app", null, null],
      ["fil_language", "Filipino language", "system", "language = fil", null, null], ["profile_incomplete", "Profile incomplete", "computed", "profile_completeness < 0.7", null, null],
    ];
    for (const [key, name, type, rule, restr, exp] of tags) run("INSERT INTO tags (id, org_id, key, name, tag_type, description, owner, refresh_policy, usage_restriction, expires_after_days, rule, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      `tag_${key}`, ORG_ID, key, name, type, rule, type === "compliance" ? "compliance@aec.local" : "crm@aec.local", type === "computed" ? "daily" : type === "event" ? "realtime" : "manual", restr, exp, rule, T);
    const tagSql: Record<string, string> = {
      high_engagement: "gaming_sessions_30d >= 30", new_member: `registered_at >= '${iso(14 * D)}'`, kyc_help_needed: "kyc_status = 'failed'", launch_issue_7d: "launch_failures_7d >= 3", search_friction: "search_no_result_7d >= 2",
      rg_excluded: "self_excluded = 1 OR rg_restricted = 1", marketing_opt_out: "marketing_opt_out = 1", cs_open_ticket: "open_tickets > 0", ios_slow_loader: "os = 'ios' AND avg_load_ms > 5000", dormant_30d: `last_active_at < '${iso(30 * D)}'`,
      prefers_live_casino: "favorite_category = 'live_casino'", prefers_slots: "favorite_category = 'slots'", app_user: "primary_platform = 'app'", fil_language: "language = 'fil'", profile_incomplete: "profile_completeness < 0.7", vip_service: "vip_tier IN ('platinum')",
    };
    for (const [k, w] of Object.entries(tagSql)) d.exec(`INSERT OR IGNORE INTO customer_tags (player_id, tag_id, source, added_at) SELECT player_id, 'tag_${k}', 'seed', '${T}' FROM customers WHERE ${w}`);
  })();

  // ───── strategies (20 versions) ─────
  d.transaction(() => {
    const hist: Record<string, Array<{ v: number; status: string; cfg: Record<string, unknown>; summary: string; daysAgo: number }>> = {
      provider_monitoring: [
        { v: 1, status: "archived", cfg: { ...DEFAULT_CONFIGS.provider_monitoring.config, failure_rate_threshold: 0.2, window_hours: 48 }, summary: "Initial strategy V1.0", daysAgo: 120 },
        { v: 2, status: "archived", cfg: { ...DEFAULT_CONFIGS.provider_monitoring.config, failure_rate_threshold: 0.15, window_hours: 24 }, summary: "Shorter window 48h → 24h", daysAgo: 75 },
        { v: 3, status: "rejected", cfg: { ...DEFAULT_CONFIGS.provider_monitoring.config, failure_rate_threshold: 0.05 }, summary: "Threshold 5% — rejected: too many false alerts", daysAgo: 40 },
        { v: 4, status: "active", cfg: DEFAULT_CONFIGS.provider_monitoring.config, summary: "Threshold 15% → 12%", daysAgo: 30 },
      ],
      kyc_assistance: [
        { v: 1, status: "archived", cfg: { ...DEFAULT_CONFIGS.kyc_assistance.config, reminder_wait_hours: 72, max_reminders: 5 }, summary: "Initial strategy V1.0", daysAgo: 150 },
        { v: 2, status: "rolled_back", cfg: { ...DEFAULT_CONFIGS.kyc_assistance.config, reminder_wait_hours: 48, max_reminders: 5 }, summary: "5 reminders — rolled back after complaint increase", daysAgo: 90 },
        { v: 3, status: "active", cfg: DEFAULT_CONFIGS.kyc_assistance.config, summary: "Max reminders 5 → 3 (duplicate notification reduction)", daysAgo: 60 },
      ],
      membership_entitlements: [
        { v: 1, status: "archived", cfg: { ...DEFAULT_CONFIGS.membership_entitlements.config, reduced_when_budget_ratio_below: 0 }, summary: "Initial strategy V1.0", daysAgo: 200 },
        { v: 2, status: "archived", cfg: { ...DEFAULT_CONFIGS.membership_entitlements.config, reduced_when_budget_ratio_below: 0.05 }, summary: "Budget guard 5%", daysAgo: 140 },
        { v: 3, status: "rejected", cfg: { ...DEFAULT_CONFIGS.membership_entitlements.config, tiers: { none: 0, reduced: 0.5, standard: 1, enhanced: 2 } }, summary: "Enhanced 2.0× — rejected by finance (budget leakage)", daysAgo: 100 },
        { v: 4, status: "archived", cfg: { ...DEFAULT_CONFIGS.membership_entitlements.config, standard_min_tenure_days: 60 }, summary: "Standard tenure 60d", daysAgo: 70 },
        { v: 5, status: "active", cfg: DEFAULT_CONFIGS.membership_entitlements.config, summary: "Standard tenure 60d → 30d; budget guard 15%", daysAgo: 35 },
      ],
      channel_routing: [
        { v: 1, status: "archived", cfg: { ...DEFAULT_CONFIGS.channel_routing.config, fallbacks: [] }, summary: "Initial strategy V1.0 (SMS only)", daysAgo: 180 },
        { v: 2, status: "archived", cfg: { ...DEFAULT_CONFIGS.channel_routing.config, fallbacks: ["email"] }, summary: "Email fallback", daysAgo: 110 },
        { v: 3, status: "active", cfg: DEFAULT_CONFIGS.channel_routing.config, summary: "Inbox fallback (zero cost)", daysAgo: 50 },
        { v: 4, status: "paused", cfg: { ...DEFAULT_CONFIGS.channel_routing.config, primary: "whatsapp" }, summary: "WhatsApp primary — paused pending provider template approval", daysAgo: 20 },
      ],
      rg_protection: [
        { v: 1, status: "archived", cfg: { ...DEFAULT_CONFIGS.rg_protection.config, create_protective_task: false }, summary: "Initial strategy V1.0", daysAgo: 300 },
        { v: 2, status: "active", cfg: DEFAULT_CONFIGS.rg_protection.config, summary: "Add protective service task", daysAgo: 100 },
      ],
    };
    for (const [cat, def] of Object.entries(DEFAULT_CONFIGS)) {
      const sid = `str_${cat}`;
      const versions = hist[cat];
      const active = versions.find((v) => v.status === "active")!;
      run("INSERT INTO strategies (id, org_id, name, category, objective, primary_metric, metric_direction, active_version, created_at) VALUES (?,?,?,?,?,?,?,?,?)", sid, ORG_ID, def.name, cat, def.objective, def.metric, def.direction, active.v, iso(versions[0].daysAgo * D));
      let prev: number | null = null;
      for (const v of versions) {
        run(`INSERT INTO strategy_versions (id, strategy_id, version, parent_version, config, status, change_summary, risk_assessment, effective_at, rollback_version, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          `stv_${cat}_${v.v}`, sid, v.v, prev, J.str(v.cfg), v.status, v.summary, "low", ["active", "archived", "rolled_back"].includes(v.status) ? iso(v.daysAgo * D) : null, prev, v.v === 1 ? "system" : "agent:optimizer", iso(v.daysAgo * D));
        if (prev != null && v.status !== "rejected") {
          const n = R.int(800, 3000), base = 0.3 + R.next() * 0.5, lift = v.status === "rolled_back" ? -0.02 : 0.01 + R.next() * 0.05;
          run("INSERT INTO experiments (id, strategy_id, name, control_version, candidate_version, allocation, metric, status, started_at, ended_at) VALUES (?,?,?,?,?,?,?,?,?,?)", `exp_${cat}_${v.v}`, sid, `v${prev} vs v${v.v}`, prev, v.v, 0.2, def.metric, "completed", iso((v.daysAgo + 14) * D), iso(v.daysAgo * D));
          run("INSERT INTO experiment_results VALUES (?,?,?,?,?,?,?,?)", `exp_${cat}_${v.v}`, "control", n, Math.round(n * base), base, null, null, null);
          run("INSERT INTO experiment_results VALUES (?,?,?,?,?,?,?,?)", `exp_${cat}_${v.v}`, "candidate", n, Math.round(n * (base + lift)), base + lift, lift - 0.02, lift + 0.02, v.status === "rolled_back" ? 0.21 : 0.003);
          run("UPDATE strategy_versions SET experiment_id = ?, baseline_metrics = ?, candidate_metrics = ? WHERE id = ?", `exp_${cat}_${v.v}`, J.str({ rate: base, n }), J.str({ rate: base + lift, n }), `stv_${cat}_${v.v}`);
        }
        if (v.status !== "rejected") prev = v.v;
      }
      for (let k = 0; k < 6; k++) run("INSERT INTO strategy_evaluations (id, strategy_id, version, metrics, verdict, notes, at) VALUES (?,?,?,?,?,?,?)", `sev_${cat}_${k}`, sid, active.v, J.str({ rate: 0.4 + R.next() * 0.4, n: R.int(200, 2000) }), "observed", "Daily evaluation", iso(k * D + 3 * H));
    }
  })();
  log("strategies");

  // ───── compliance policies, settings, integrations ─────
  d.transaction(() => {
    const pol: Array<[string, string, string, number, Record<string, unknown>]> = [
      ["age_eligibility", "Age eligibility", "Promotional activity only for players at or above the configured minimum age (demo default 21+; verify applicable PH rules)", 1, { min_age: 21 }],
      ["kyc_required", "KYC required for promotions", "Promotional communications and incentives require verified KYC", 1, {}],
      ["channel_consent", "Channel-specific consent", "Each channel requires consent for the purpose (service vs marketing)", 1, {}],
      ["marketing_opt_out", "Marketing opt-out", "Opted-out players never receive promotional content", 1, {}],
      ["self_exclusion", "Self-exclusion", "Self-excluded players are excluded from all promotions and incentives", 1, {}],
      ["responsible_gaming", "Responsible gaming restrictions", "RG-restricted players are excluded from promotions and incentives", 1, {}],
      ["frequency_cap", "Frequency caps", "Max promotional messages per player", 0, { per_day: 2, per_week: 5 }],
      ["quiet_hours", "Quiet hours", "No promotional sends during local quiet hours", 0, { start_hour: 22, end_hour: 8, utc_offset_hours: 8 }],
      ["duplicate_prevention", "Duplicate prevention", "Idempotency keys on every message and entitlement", 1, {}],
      ["approval_requirements", "Approval requirements", "Entitlements, promotional campaigns and strategy activations require approval", 1, { high_risk_levels: 2 }],
    ];
    for (const [k, n, desc, m, cfg] of pol) run("INSERT INTO compliance_policies (key, name, description, mandatory, enabled, config, updated_at) VALUES (?,?,?,?,1,?,?)", k, n, desc, m, J.str(cfg), T);
    const settings: Record<string, unknown> = {
      emergency_stop: "false", optimizer: J.str({ auto_optimization: true, evaluation_frequency_hours: 24, min_sample: 200, min_improvement: 0.02, confidence: 0.95, max_deterioration: 0.01, risk_threshold: "medium", approval_mode: "manual", auto_rollback: true, experiment_allocation: 0.2 }),
      policy: J.str({ max_auto_audience: 2000 }), scheduler: J.str({ discovery_scan_minutes: 0, journey_tick_seconds: 30 }), organization: J.str({ name: "Demo Gaming Group (synthetic)", timezone: "Asia/Manila", currency: "PHP", data_retention_days: 730, audit_retention_days: 2555 }),
    };
    for (const [k, v] of Object.entries(settings)) run("INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?,?,?,?)", k, String(v), "system", T);
    const flags: Array<[string, string, number]> = [["ai_copilot", "AI Copilot", 1], ["auto_mode", "Automatic decision mode", 1], ["real_ai_provider", "Use configured real AI provider", 0], ["live_channels", "Live channel sending (requires verified integration)", 0], ["ai_segment_builder", "AI Segment Builder", 1]];
    for (const [k, desc, e] of flags) run("INSERT INTO feature_flags (key, description, enabled, updated_at) VALUES (?,?,?,?)", k, desc, e, T);
    const ds: Array<[string, string, string, string, number, number]> = [
      ["ds_events", "Event stream (gaming + customer)", "events", "webhook/api", evn, 1], ["ds_bi", "Enterprise BI warehouse", "bi", "database", N, 60], ["ds_crm", "CRM / player core", "crm", "database", N, 15],
      ["ds_kyc", "KYC provider", "kyc", "rest", N, 30], ["ds_payment", "Payment system (restricted)", "payment", "database", N, 60], ["ds_cs", "Customer service desk", "customer_service", "rest", Math.floor(N * 0.15), 10],
      ["ds_offers", "Promotion / entitlement system", "offers", "rest", 30, 30], ["ds_csv", "CSV import", "file", "csv", 0, 0],
    ];
    for (const [i, n, k, t, rec, f] of ds) run("INSERT INTO data_sources (id, name, source_type, kind, mode, status, last_sync_at, records, freshness_minutes, config) VALUES (?,?,?,?,?,?,?,?,?,?)", i, n, t, k, "mock", "connected_mock", iso(f * 60000), rec, f, J.str({ note: "Mock adapter — see docs/INTEGRATIONS.md to enable" }));
    const prov: Array<[string, string, string, string | null, string, string]> = [["aip_mock", "Mock (deterministic)", "mock", null, "aec-mock-1", ""], ["aip_anthropic", "Anthropic", "anthropic", "https://api.anthropic.com", "claude-sonnet-5-5", "ANTHROPIC_API_KEY"], ["aip_openai", "OpenAI", "openai", "https://api.openai.com/v1", "gpt-4.1-mini", "OPENAI_API_KEY"], ["aip_gemini", "Google Gemini (OpenAI-compatible)", "openai_compatible", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-flash", "OPENAI_COMPATIBLE_API_KEY"], ["aip_deepseek", "DeepSeek", "openai_compatible", "https://api.deepseek.com/v1", "deepseek-chat", "OPENAI_COMPATIBLE_API_KEY"], ["aip_ollama", "Ollama (local)", "openai_compatible", "http://localhost:11434/v1", "llama3.1", ""]];
    for (const [i, n, t, u, m, e] of prov) run("INSERT INTO ai_providers (id, name, provider_type, base_url, model, env_key, enabled, is_default, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", i, n, t, u, m, e, t === "mock" ? 1 : 0, t === "mock" ? 1 : 0, T);
    for (const a of AGENTS) run("INSERT INTO ai_agents (key, name, description, enabled, model, allowed_tools, config, updated_at) VALUES (?,?,?,1,?,?,?,?)", a.key, a.name, a.description, "default", J.str(a.tools), J.str({ max_retries: 2, timeout_s: 60 }), T);
    for (const [sc, w] of Object.entries(WORKFLOWS)) run("INSERT INTO ai_workflows (id, name, description, scenario, strategy_category, definition, default_mode, created_at) VALUES (?,?,?,?,?,?,?,?)", w.id, w.name, w.description, sc, w.strategy, J.str(w.nodes), "manual", T);
    // demo ingestion key (local mock only) — documented in README; revoke in Settings for any shared environment
    if (!isPublic()) run("INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)", "key_demo", ORG_ID, "Demo event ingestion", "aec_demo_", hashStable("aec_demo_ingest_key_local_only"), J.str(["events.ingest"]), "system", T);
    run("INSERT INTO webhooks (id, org_id, url, events, enabled, secret_ref, created_at) VALUES (?,?,?,?,0,?,?)", "wh_1", ORG_ID, "https://example.invalid/hooks/aec", J.str(["approval.created", "strategy.activated"]), "env:AEC_WEBHOOK_SECRET", T);
  })();

  // ───── templates ─────
  d.transaction(() => {
    const tpl = (idx: string, name: string, ch: string, lang: string, purpose: string, body: string, status = "approved", subject?: string) =>
      run("INSERT INTO message_templates (id, org_id, name, channel, language, purpose, subject, body, variables, status, provider_approval, compliance_result, version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)",
        idx, ORG_ID, name, ch, lang, purpose, subject ?? null, body, J.str((body.match(/\{\{\s*(\w+)\s*\}\}/g) ?? []).map((x) => x.replace(/[{}\s]/g, ""))), status, ["whatsapp", "viber", "messenger"].includes(ch) ? "approved" : "not_required", J.str({ passed: true, issues: [] }), iso(30 * D), iso(30 * D));
    for (const ch of ["inbox", "app_push", "sms", "email", "viber"]) tpl(`tpl_incident_${ch}`, `Provider incident notice (${ch})`, ch, "en", "service", "Hi {{first_name}}, some games from one of our providers are loading slowly or failing to open. Our team is working on it — your account and balance are safe. We'll update you once it's fixed.");
    for (const ch of ["sms", "email", "app_push", "inbox", "viber", "whatsapp"]) tpl(`tpl_account_${ch}`, `Account notice (${ch})`, ch, "en", "service", "Hi {{first_name}}, we tried to reach you about an update to your account. Please open the app or reply HELP for support.");
    tpl("tpl_kyc_sms", "KYC reminder (sms)", "sms", "en", "service", "Hi {{first_name}}, your account verification is almost done. Tip: use a clear, well-lit photo of a valid ID. Finish here: app > Profile > Verify. Reply HELP for support.");
    tpl("tpl_kyc_email", "KYC reminder (email)", "email", "en", "service", "Hi {{first_name}}, we noticed your verification is not complete yet. Common fixes: ensure all ID corners are visible and the name matches your profile. Need help? Contact support any time.", "approved", "Finish verifying your account");
    tpl("tpl_kyc_sms_fil", "KYC reminder (sms, Filipino)", "sms", "fil", "service", "Hi {{first_name}}, malapit nang matapos ang verification ng account mo. Gumamit ng malinaw na litrato ng valid ID. Reply HELP para sa tulong.");
    tpl("tpl_security_push", "Security alert (push)", "app_push", "en", "security", "New sign-in to your account detected. If this wasn't you, change your password now.");
    tpl("tpl_member_inbox", "Membership benefit available (inbox)", "inbox", "en", "membership", "Hi {{first_name}}, your monthly membership benefit is ready in your rewards wallet. Terms apply. 21+ only. Play responsibly. Manage preferences or opt out in Settings.");
    tpl("tpl_member_email", "Membership update (email)", "email", "en", "membership", "Hi {{first_name}}, thanks for being a member. Your membership tier summary is now available. 21+ only. Play responsibly. Unsubscribe anytime.", "approved", "Your membership summary");
    tpl("tpl_promo_push", "Weekend tournament (push)", "app_push", "en", "marketing", "Weekend tournament is live! 21+ only. Play responsibly. Opt out in Settings.");
    tpl("tpl_promo_push_b", "Weekend tournament B (push)", "app_push", "en", "marketing", "Join this weekend's leaderboard event. 21+ only. Play responsibly. Opt out in Settings.");
    tpl("tpl_promo_sms_draft", "Festival promo (sms) — draft", "sms", "en", "marketing", "Festival bonus coming soon for {{first_name}}! Reply STOP to opt out. 21+ only.", "draft");
    tpl("tpl_ops_maint", "Maintenance notice (inbox)", "inbox", "en", "operational", "Scheduled maintenance tonight 02:00–03:00 PHT. Some games may be unavailable.");
    tpl("tpl_rg_support", "Support resources (inbox)", "inbox", "en", "protective", "Your request has been applied. If you'd like to talk to someone, support resources are available 24/7 from Settings > Responsible Gaming.");
  })();

  // ───── segments (30) ─────
  const segDefs: Array<[string, string, string, string, Rule]> = [
    ["KYC stalled", "service", "dynamic", "Pending/failed KYC not updated in 24h", { type: "group", op: "and", children: [{ type: "attr", field: "kyc_status", op: "in", value: ["pending", "failed"] }, { type: "attr", field: "kyc_updated_at", op: "older_than_days", value: 1 }, { type: "attr", field: "account_status", op: "eq", value: "active" }] }],
    ["Verified active members", "membership", "dynamic", "KYC-verified members active in 30 days", { type: "group", op: "and", children: [{ type: "attr", field: "kyc_status", op: "eq", value: "verified" }, { type: "attr", field: "last_active_at", op: "within_last_days", value: 30 }] }],
    ["Launch failures 7d", "service", "realtime", "≥3 failed launches in 7 days", { type: "group", op: "and", children: [{ type: "event", event: "game_launch_failed", op: "gte", count: 3, within_days: 7 }] }],
    ["Launch failure + open ticket", "service", "realtime", "Loading failures and unresolved CS tickets", { type: "group", op: "and", children: [{ type: "event", event: "game_launch_failed", op: "gte", count: 1, within_days: 7 }, { type: "attr", field: "open_tickets", op: "gt", value: 0 }] }],
    ["New members (14d)", "service", "dynamic", "Registered in the last 14 days", { type: "group", op: "and", children: [{ type: "attr", field: "registered_at", op: "within_last_days", value: 14 }] }],
    ["Dormant 30–90d", "membership", "dynamic", "Inactive 30–90 days, verified", { type: "group", op: "and", children: [{ type: "attr", field: "last_active_at", op: "older_than_days", value: 30 }, { type: "attr", field: "last_active_at", op: "within_last_days", value: 90 }, { type: "attr", field: "kyc_status", op: "eq", value: "verified" }] }],
    ["Search friction", "service", "realtime", "≥2 no-result searches in 7 days", { type: "group", op: "and", children: [{ type: "event", event: "game_search_no_result", op: "gte", count: 2, within_days: 7 }] }],
    ["iOS slow loaders", "service", "dynamic", "iOS players with avg load > 5s", { type: "group", op: "and", children: [{ type: "attr", field: "os", op: "eq", value: "ios" }, { type: "attr", field: "avg_load_ms", op: "gt", value: 5000 }] }],
    ["Gold & Platinum", "membership", "dynamic", "Top membership tiers", { type: "group", op: "and", children: [{ type: "attr", field: "vip_tier", op: "in", value: ["gold", "platinum"] }] }],
    ["App users", "service", "dynamic", "Primary platform app", { type: "group", op: "and", children: [{ type: "attr", field: "primary_platform", op: "eq", value: "app" }] }],
    ["H5 users", "service", "dynamic", "Primary platform H5", { type: "group", op: "and", children: [{ type: "attr", field: "primary_platform", op: "eq", value: "h5" }] }],
    ["PC users", "service", "dynamic", "Primary platform PC", { type: "group", op: "and", children: [{ type: "attr", field: "primary_platform", op: "eq", value: "pc" }] }],
    ["Live casino fans", "marketing", "dynamic", "Favourite category live casino", { type: "group", op: "and", children: [{ type: "attr", field: "favorite_category", op: "eq", value: "live_casino" }, { type: "attr", field: "kyc_status", op: "eq", value: "verified" }] }],
    ["Slots fans", "marketing", "dynamic", "Favourite category slots", { type: "group", op: "and", children: [{ type: "attr", field: "favorite_category", op: "eq", value: "slots" }, { type: "attr", field: "kyc_status", op: "eq", value: "verified" }] }],
    ["Filipino speakers", "service", "dynamic", "Language fil", { type: "group", op: "and", children: [{ type: "attr", field: "language", op: "eq", value: "fil" }] }],
    ["Profile incomplete", "service", "dynamic", "Completeness < 70%", { type: "group", op: "and", children: [{ type: "attr", field: "profile_completeness", op: "lt", value: 0.7 }] }],
    ["Open CS tickets", "service", "realtime", "Unresolved service tickets", { type: "group", op: "and", children: [{ type: "attr", field: "open_tickets", op: "gt", value: 0 }] }],
    ["KYC failed — blurry docs", "service", "dynamic", "KYC failed (any reason) needing help", { type: "group", op: "and", children: [{ type: "attr", field: "kyc_status", op: "eq", value: "failed" }] }],
    ["KYC not started (7d+)", "service", "dynamic", "Registered >7d, KYC not started", { type: "group", op: "and", children: [{ type: "attr", field: "kyc_status", op: "eq", value: "not_started" }, { type: "attr", field: "registered_at", op: "older_than_days", value: 7 }] }],
    ["Engaged members", "membership", "dynamic", "Active with ≥10 sessions in 30d", { type: "group", op: "and", children: [{ type: "attr", field: "gaming_sessions_30d", op: "gte", value: 10 }, { type: "attr", field: "kyc_status", op: "eq", value: "verified" }] }],
    ["Multi-identity players", "service", "dynamic", "Has tag multi_platform OR app+h5", { type: "group", op: "or", children: [{ type: "tag", tag: "multi_platform", has: true }, { type: "tag", tag: "app_user", has: true }] }],
    ["Weekend tournament audience", "marketing", "dynamic", "Verified, active 14d, app users", { type: "group", op: "and", children: [{ type: "attr", field: "kyc_status", op: "eq", value: "verified" }, { type: "attr", field: "last_active_at", op: "within_last_days", value: 14 }, { type: "attr", field: "primary_platform", op: "eq", value: "app" }] }],
    ["Disconnect sufferers", "service", "realtime", "≥2 disconnects in 7 days", { type: "group", op: "and", children: [{ type: "event", event: "game_disconnect", op: "gte", count: 2, within_days: 7 }] }],
    ["Nebula Play affected (24h)", "service", "realtime", "Failed launches on Nebula Play in 24h", { type: "group", op: "and", children: [{ type: "event", event: "game_launch_failed", op: "gte", count: 1, within_days: 1, provider_id: "prv_03" }] }],
    ["Manila members", "membership", "dynamic", "City Manila, verified", { type: "group", op: "and", children: [{ type: "attr", field: "city", op: "eq", value: "Manila" }, { type: "attr", field: "kyc_status", op: "eq", value: "verified" }] }],
    ["Recently verified (7d)", "service", "dynamic", "KYC changed to verified in 7d", { type: "group", op: "and", children: [{ type: "attr_change", field: "kyc_status", to: "verified", within_days: 7 }] }],
    ["At-risk members", "membership", "dynamic", "Lifecycle at_risk", { type: "group", op: "and", children: [{ type: "attr", field: "lifecycle_stage", op: "eq", value: "at_risk" }] }],
    ["Gold minus app users", "membership", "dynamic", "Set difference example", { type: "group", op: "and", children: [{ type: "attr", field: "vip_tier", op: "eq", value: "gold" }, { type: "attr", field: "primary_platform", op: "neq", value: "app" }] }],
    ["Pilot static list", "service", "static", "Static snapshot for pilot", { type: "group", op: "and", children: [{ type: "attr", field: "city", op: "eq", value: "Baguio" }] }],
    ["Email reachable service", "service", "dynamic", "Profile completeness ≥ 0.8", { type: "group", op: "and", children: [{ type: "attr", field: "profile_completeness", op: "gte", value: 0.8 }] }],
  ];
  d.transaction(() => {
    segDefs.forEach(([name, purpose, type, desc, rules], i) => {
      const sid = `seg_${String(i + 1).padStart(2, "0")}`;
      run("INSERT INTO segments (id, org_id, name, description, segment_type, purpose, rules, version, status, refresh_schedule, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,1,'active',?,?,?,?)", sid, ORG_ID, name, desc, type, purpose, J.str(rules), type === "static" ? null : type === "realtime" ? "realtime" : "hourly", "crm@aec.local", iso((40 - i) * D), iso((40 - i) * D));
      run("INSERT INTO segment_versions (segment_id, version, rules, created_by, created_at) VALUES (?,?,?,?,?)", sid, 1, J.str(rules), "crm@aec.local", iso((40 - i) * D));
    });
  })();
  for (const s of all<{ id: string }>("SELECT id FROM segments")) evaluateSegment(s.id, SYSTEM, "initial_build");
  log("segments");

  // ───── offers (30) & budgets ─────
  d.transaction(() => {
    const offers: Array<[string, string, string, number, Record<string, unknown>, number, number, string]> = [
      ["off_member_monthly", "Monthly membership benefit", "membership_benefit", 100, { kyc_required: true, min_tenure_days: 7 }, 1, 1, "active"],
      ["off_launch_comp", "Service compensation — game launch failure", "service_compensation", 50, { kyc_required: true, min_launch_failures_7d: 1 }, 1, 0, "active"],
      ["off_birthday", "Birthday membership gift", "membership_benefit", 200, { kyc_required: true, min_tenure_days: 90 }, 1, 1, "active"],
      ["off_tier_upgrade", "Tier upgrade benefit", "membership_benefit", 300, { kyc_required: true, vip_tiers: ["gold", "platinum"] }, 1, 1, "active"],
      ["off_contract_vip", "Contractual VIP entitlement", "contractual", 1000, { kyc_required: true, vip_tiers: ["platinum"] }, 1, 1, "active"],
      ["off_weekend_promo", "Weekend tournament entry (regulated)", "regulated_promotion", 100, { kyc_required: true }, 1, 1, "active"],
      ["off_maint_comp", "Maintenance downtime compensation", "service_compensation", 30, { kyc_required: true, min_launch_failures_7d: 1 }, 1, 0, "draft"],
    ];
    for (let k = offers.length; k < 30; k++) offers.push([`off_cfg_${k}`, `${R.pick(["Loyalty", "Anniversary", "Service recovery", "Feedback thank-you", "Profile completion", "Referral"])} entitlement ${k}`, R.pick(["membership_benefit", "service_compensation", "contractual", "regulated_promotion"]), R.pick([20, 50, 80, 100, 150]), { kyc_required: true, min_tenure_days: R.pick([0, 30, 60]) }, 1, R.chance(0.5) ? 1 : 0, R.pick(["active", "draft", "paused", "archived"])]);
    for (const [oid, name, cat, base, elig, lim, appr, status] of offers) {
      run("INSERT INTO offers (id, org_id, name, category, description, base_amount, unit, eligibility, validity_days, redemption_conditions, distribution_limit, per_user_limit, status, version, requires_approval, allow_personalization, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)",
        oid, ORG_ID, name, cat, `${name} (synthetic configuration)`, base, "PHP", J.str(elig), 14, cat === "regulated_promotion" ? "Subject to published terms; 21+; KYC verified" : "Non-transferable; expires after validity period", null, lim, status, appr, cat === "membership_benefit" ? 1 : 0, iso(60 * D), iso(60 * D));
      run("INSERT INTO offer_versions (offer_id, version, snapshot, created_by, created_at) VALUES (?,?,?,?,?)", oid, 1, J.str({ base, elig, status }), "crm@aec.local", iso(60 * D));
    }
    const pStart = iso(10 * D), pEnd = new Date(NOW + 20 * D).toISOString();
    run("INSERT INTO offer_budgets (id, org_id, name, scope, offer_id, total, reserved, spent, daily_limit, period_start, period_end, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", "bud_member", ORG_ID, "Membership benefit — monthly", "offer", "off_member_monthly", 300000, 0, 0, 50000, pStart, pEnd, T);
    run("INSERT INTO offer_budgets (id, org_id, name, scope, offer_id, total, reserved, spent, daily_limit, period_start, period_end, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", "bud_comp", ORG_ID, "Service compensation pool", "offer", "off_launch_comp", 60000, 0, 0, 20000, pStart, pEnd, T);
    run("INSERT INTO offer_budgets (id, org_id, name, scope, offer_id, total, reserved, spent, daily_limit, period_start, period_end, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", "bud_bday", ORG_ID, "Birthday gifts", "offer", "off_birthday", 80000, 0, 0, null, pStart, pEnd, T);
    run("INSERT INTO offer_budgets (id, org_id, name, scope, offer_id, total, reserved, spent, daily_limit, period_start, period_end, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", "bud_total", ORG_ID, "Total entitlement budget (all offers)", "total", null, 1500000, 0, 0, null, pStart, pEnd, T);
  })();
  // historic issued entitlements for birthday offer (realistic lifecycle data)
  d.transaction(() => {
    const elig = players.filter((p) => p.kyc === "verified" && !p.excl && !p.rg && p.age >= 21).slice(0, 220);
    let reserved = 0, spent = 0;
    elig.forEach((p, k) => {
      const st = R.weighted([["issued", 25], ["claimed", 20], ["redeemed", 40], ["expired", 15]] as const);
      const amt = 200;
      if (st === "issued" || st === "claimed") reserved += amt; if (st === "redeemed") spent += amt;
      run("INSERT INTO offer_transactions (id, idempotency_key, decision_id, player_id, offer_id, budget_id, amount, status, history, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", `otx_h${k}`, `hist:bday:${p.id}`, null, p.id, "off_birthday", "bud_bday", amt, st, J.str([{ status: "issued", at: iso(9 * D) }, ...(st !== "issued" ? [{ status: st, at: iso(R.int(1, 8) * D) }] : [])]), new Date(NOW + 5 * D).toISOString(), iso(9 * D), iso(R.int(1, 8) * D));
    });
    run("UPDATE offer_budgets SET reserved = ?, spent = ? WHERE id = 'bud_bday'", reserved, spent);
    for (let k = 0; k < 18; k++) run("INSERT INTO duplicate_prevention_log (kind, key, player_id, at) VALUES ('offer', ?, ?, ?)", `hist:bday:${elig[k].id}`, elig[k].id, iso(R.int(1, 8) * D));
  })();
  log("offers");

  // ───── campaigns (20) & message history ─────
  const insM = ins("INSERT INTO messages (id, org_id, idempotency_key, player_id, channel, template_id, purpose, campaign_id, journey_id, run_id, variant, status, cost, error_code, simulated, body_preview, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)");
  const insDE = ins("INSERT OR IGNORE INTO delivery_events (message_id, status, error_code, at) VALUES (?,?,?,?)");
  let mcount = 0;
  d.transaction(() => {
    const camps: Array<[string, string, string, string, string, string[], string, string | null]> = [
      ["Provider maintenance notice", "operational_notice", "operational", "seg_10", "completed", ["inbox"], "tpl_ops_maint", null],
      ["KYC help — failed documents", "service_communication", "service", "seg_18", "completed", ["sms", "email"], "tpl_kyc_sms", null],
      ["Security reminder — new device", "account_security", "security", "seg_10", "completed", ["app_push"], "tpl_security_push", null],
      ["Weekend tournament", "regulated_marketing", "marketing", "seg_22", "completed", ["app_push"], "tpl_promo_push", J.str({ variant_b_template_id: "tpl_promo_push_b", split: 0.5 })],
      ["Membership benefit ready", "membership_communication", "membership", "seg_02", "completed", ["inbox"], "tpl_member_inbox", null],
      ["Membership summary email", "membership_communication", "membership", "seg_09", "completed", ["email"], "tpl_member_email", null],
      ["Account notice (SMS)", "service_communication", "service", "seg_17", "completed", ["sms"], "tpl_account_sms", null],
      ["Search improvement survey", "service_communication", "service", "seg_07", "completed", ["inbox"], "tpl_account_inbox", null],
      ["iOS loading fix notice", "service_communication", "service", "seg_08", "completed", ["app_push"], "tpl_incident_app_push", null],
      ["Viber account notice", "service_communication", "service", "seg_15", "completed", ["viber"], "tpl_account_viber", null],
      ["Festival promo (draft)", "regulated_marketing", "marketing", "seg_14", "draft", ["sms"], "tpl_promo_sms_draft", null],
      ["Dormant member check-in", "membership_communication", "membership", "seg_06", "draft", ["email"], "tpl_member_email", null],
      ["Live casino tournament", "regulated_marketing", "marketing", "seg_13", "pending_approval", ["app_push"], "tpl_promo_push", null],
      ["KYC not started nudge", "service_communication", "service", "seg_19", "approved", ["sms"], "tpl_kyc_sms", null],
      ["Profile completion help", "service_communication", "service", "seg_16", "draft", ["inbox"], "tpl_account_inbox", null],
      ["Gold tier summary", "membership_communication", "membership", "seg_28", "cancelled", ["email"], "tpl_member_email", null],
      ["Maintenance (PC)", "operational_notice", "operational", "seg_12", "completed", ["inbox"], "tpl_ops_maint", null],
      ["Disconnect apology", "service_communication", "service", "seg_23", "completed", ["inbox"], "tpl_incident_inbox", null],
      ["Manila members update", "membership_communication", "membership", "seg_25", "paused", ["inbox"], "tpl_member_inbox", null],
      ["WhatsApp service pilot", "service_communication", "service", "seg_29", "completed", ["whatsapp"], "tpl_account_whatsapp", null],
    ];
    const consentOk = new Map<string, Set<string>>();
    for (const r of all<{ player_id: string; channel: string; purpose: string }>("SELECT player_id, channel, purpose FROM consent_current WHERE granted = 1")) { const k = `${r.channel}:${r.purpose}`; if (!consentOk.has(k)) consentOk.set(k, new Set()); consentOk.get(k)!.add(r.player_id); }
    const blocked = new Set(all<{ player_id: string }>("SELECT player_id FROM customers WHERE self_excluded = 1 OR rg_restricted = 1 OR marketing_opt_out = 1 OR kyc_status != 'verified' OR age < 21 OR account_status != 'active'").map((r) => r.player_id));
    camps.forEach(([name, obj, purpose, seg, status, chans, tplId, ab], k) => {
      const cid = `cmp_${String(k + 1).padStart(2, "0")}`;
      const sentAgo = R.int(1, 13) * D + R.int(0, 20) * H;
      run(`INSERT INTO campaigns (id, org_id, name, objective, purpose, status, segment_id, channels, template_id, schedule_at, timezone, budget, ab_test, version, strategy_id, strategy_version, stats, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)`,
        cid, ORG_ID, name, obj, purpose, status, seg, J.str(chans), tplId, status === "completed" ? iso(sentAgo) : null, "Asia/Manila", 5000, ab, "str_channel_routing", 3, "{}", "crm@aec.local", iso(sentAgo + 2 * D), iso(sentAgo));
      run("INSERT INTO campaign_versions (campaign_id, version, snapshot, created_by, created_at) VALUES (?,?,?,?,?)", cid, 1, J.str({ name, obj, seg, chans }), "crm@aec.local", iso(sentAgo + 2 * D));
      if (status !== "completed") return;
      const members = all<{ player_id: string }>("SELECT player_id FROM segment_memberships WHERE segment_id = ? LIMIT 2500", seg).map((r) => r.player_id);
      const ch = chans[0];
      const cfg = CHANNEL_DEFS.find((c) => c.key === ch)!;
      const promo = purpose === "marketing" || purpose === "membership";
      const cons = consentOk.get(`${cfg.consent}:${promo ? "marketing" : "service"}`) ?? new Set();
      let sent = 0, cost = 0;
      for (const pid of members) {
        if (!cons.has(pid) || (promo && blocked.has(pid))) continue;
        const mid = `msg_c${k}_${pid}`;
        const at = sentAgo - R.int(0, 3600) * 1000;
        const deliveredRate = ch === "sms" ? (at < D ? 0.74 : 0.95) : cfg.cfg.mock_delivery_rate;
        const variant = ab ? (R.chance(0.5) ? "B" : "A") : null;
        const del = R.chance(deliveredRate), rd = del && R.chance(cfg.cfg.mock_read_rate * (variant === "B" ? 1.15 : 1)), ck = rd && R.chance(cfg.cfg.mock_click_rate * 2);
        const st = !del ? "failed" : ck ? "clicked" : rd ? "read" : "delivered";
        const err = !del ? (ch === "sms" ? R.weighted([["SMS_ROUTE_UNAVAILABLE", 60], ["SMS_CARRIER_REJECTED", 30], ["SMS_THROTTLED", 10]] as const) : "PROVIDER_ERROR") : null;
        insM.run(mid, ORG_ID, `campaign:${cid}:v1:${variant ?? "A"}:${pid}:${ch}`, pid, ch, variant === "B" ? "tpl_promo_push_b" : tplId, purpose, cid, null, null, variant, st, cfg.cost, err, "Campaign message (seed)", iso(at), iso(at));
        insDE.run(mid, "sent", null, iso(at)); if (del) insDE.run(mid, "delivered", null, iso(at)); else insDE.run(mid, "failed", err, iso(at)); if (rd) insDE.run(mid, "read", null, iso(at)); if (ck) insDE.run(mid, "clicked", null, iso(at));
        sent++; cost += cfg.cost; mcount++;
      }
      run("UPDATE campaigns SET stats = ? WHERE id = ?", J.str({ audience: members.length, sent, cost: Math.round(cost * 100) / 100, executed_at: iso(sentAgo) }), cid);
    });
    // transactional service SMS traffic: last 24h degraded (SMS route failures) vs prior week healthy
    const svcSms = consentOk.get("sms:service") ?? new Set();
    const pool = [...svcSms].slice(0, 4000);
    for (let k = 0; k < Math.min(6000, pool.length * 2); k++) {
      const pid = pool[k % pool.length]; const recent = k % 3 === 0;
      const at = recent ? R.int(0, 23 * 3600) * 1000 : R.int(25, 7 * 24) * H;
      const ok = R.chance(recent ? 0.72 : 0.96);
      const mid = `msg_tx${k}`;
      insM.run(mid, ORG_ID, `otp:${k}`, pid, "sms", "tpl_account_sms", "service", null, null, null, null, ok ? "delivered" : "failed", 0.45, ok ? null : R.weighted([["SMS_ROUTE_UNAVAILABLE", 65], ["SMS_CARRIER_REJECTED", 25], ["SMS_THROTTLED", 10]] as const), "Account notice (seed)", iso(at), iso(at));
      insDE.run(mid, "sent", null, iso(at)); insDE.run(mid, ok ? "delivered" : "failed", null, iso(at)); mcount++;
    }
    // historic viber/inbox service traffic (for routing evaluation)
    const vb = [...(consentOk.get("viber:service") ?? new Set())].slice(0, 1500);
    vb.forEach((pid, k) => { const at = R.int(1, 7 * 24) * H; const ok = R.chance(0.95); const mid = `msg_vb${k}`; insM.run(mid, ORG_ID, `vbsvc:${k}`, pid, "viber", "tpl_account_viber", "service", null, null, null, null, ok ? "delivered" : "failed", 0.18, ok ? null : "VIBER_NOT_SUBSCRIBED", "Account notice (seed)", iso(at), iso(at)); insDE.run(mid, ok ? "delivered" : "failed", null, iso(at)); mcount++; });
  })();
  log(`${mcount} messages`);

  // ───── journeys (10) ─────
  d.transaction(() => {
    const mk = (nodes: Array<[string, string, string, Record<string, unknown>, number, number]>, edges: Array<[string, string, string?]>, exit?: Record<string, unknown>) => J.str({ nodes: nodes.map(([idn, type, kind, data, x, y]) => ({ id: idn, type, kind, data, position: { x, y } })), edges: edges.map(([s, t, h], i) => ({ id: `e${i}`, source: s, target: t, sourceHandle: h ?? null })), exit });
    const kyc = mk([["t1", "trigger", "segment_entry", { segment_id: "seg_01", label: "Enters KYC stalled" }, 0, 0], ["a1", "action", "send_message", { channel: "sms", template_id: "tpl_kyc_sms", label: "SMS guidance" }, 0, 120], ["w1", "flow", "wait", { strategy_param: "reminder_wait_hours", hours: 48, label: "Wait (strategy)" }, 0, 240],
      ["c1", "condition", "user_attribute", { field: "kyc_status", op: "eq", value: "verified", label: "KYC verified?" }, 0, 360], ["e1", "flow", "end", { label: "Done" }, -200, 480], ["a2", "action", "send_message", { channel: "email", template_id: "tpl_kyc_email", label: "Email guidance" }, 200, 480],
      ["w2", "flow", "wait", { strategy_param: "reminder_wait_hours", hours: 48 }, 200, 600], ["a3", "action", "create_ticket", { category: "kyc_help", subject: "Proactive KYC assistance call" }, 200, 720], ["e2", "flow", "end", {}, 200, 840]],
      [["t1", "a1"], ["a1", "w1"], ["w1", "c1"], ["c1", "e1", "yes"], ["c1", "a2", "no"], ["a2", "w2"], ["w2", "a3"], ["a3", "e2"]], { on_trigger_segment_exit: true });
    const js: Array<[string, string, string, string, string, string | null]> = [
      ["jrn_kyc", "KYC Assistance", "service", "draft", kyc, "kyc_assistance"],
      ["jrn_launch", "Launch failure follow-up", "service", "active", mk([["t1", "trigger", "event_trigger", { event: "game_launch_failed" }, 0, 0], ["c1", "condition", "event_condition", { event: "game_launch_failed", op: "gte", count: 3, within_days: 1 }, 0, 120], ["a1", "action", "send_message", { channel: "inbox", template_id: "tpl_incident_inbox" }, -150, 240], ["e1", "flow", "end", {}, 150, 240], ["e2", "flow", "end", {}, -150, 360]], [["t1", "c1"], ["c1", "a1", "yes"], ["c1", "e1", "no"], ["a1", "e2"]]), "provider_monitoring"],
      ["jrn_welcome", "New member onboarding (service)", "service", "active", mk([["t1", "trigger", "segment_entry", { segment_id: "seg_05" }, 0, 0], ["a1", "action", "send_message", { channel: "inbox", template_id: "tpl_account_inbox" }, 0, 120], ["w1", "flow", "wait", { hours: 24 }, 0, 240], ["c1", "condition", "user_attribute", { field: "kyc_status", op: "eq", value: "verified" }, 0, 360], ["e1", "flow", "end", {}, -150, 480], ["a2", "action", "update_tag", { tag: "kyc_help_needed" }, 150, 480], ["e2", "flow", "end", {}, 150, 600]], [["t1", "a1"], ["a1", "w1"], ["w1", "c1"], ["c1", "e1", "yes"], ["c1", "a2", "no"], ["a2", "e2"]]), null],
      ["jrn_member", "Membership benefit journey", "membership", "draft", mk([["t1", "trigger", "segment_entry", { segment_id: "seg_09" }, 0, 0], ["c1", "condition", "compliance", { purpose: "membership" }, 0, 120], ["a1", "action", "evaluate_entitlement", { offer_id: "off_tier_upgrade" }, -150, 240], ["e0", "flow", "end", {}, 150, 240], ["a2", "action", "issue_entitlement", { offer_id: "off_tier_upgrade" }, -150, 360], ["a3", "action", "send_message", { channel: "inbox", template_id: "tpl_member_inbox" }, -150, 480], ["e1", "flow", "end", {}, -150, 600]], [["t1", "c1"], ["c1", "a1", "yes"], ["c1", "e0", "no"], ["a1", "a2"], ["a2", "a3"], ["a3", "e1"]]), "membership_entitlements"],
      ["jrn_search", "Search friction help", "service", "paused", mk([["t1", "trigger", "segment_entry", { segment_id: "seg_07" }, 0, 0], ["a1", "action", "send_message", { channel: "inbox", template_id: "tpl_account_inbox" }, 0, 120], ["e1", "flow", "end", {}, 0, 240]], [["t1", "a1"], ["a1", "e1"]]), null],
      ["jrn_ios", "iOS slow loading support", "service", "draft", mk([["t1", "trigger", "segment_entry", { segment_id: "seg_08" }, 0, 0], ["s1", "flow", "random_split", { percent_a: 50 }, 0, 120], ["a1", "action", "send_message", { channel: "app_push", template_id: "tpl_incident_app_push" }, -150, 240], ["a2", "action", "send_message", { channel: "inbox", template_id: "tpl_incident_inbox" }, 150, 240], ["e1", "flow", "end", {}, 0, 360]], [["t1", "s1"], ["s1", "a1", "a"], ["s1", "a2", "b"], ["a1", "e1"], ["a2", "e1"]]), null],
      ["jrn_ticket", "Open ticket reassurance", "service", "draft", mk([["t1", "trigger", "segment_entry", { segment_id: "seg_17" }, 0, 0], ["w1", "flow", "delay", { hours: 4 }, 0, 120], ["a1", "action", "notify_employee", { message: "Follow up on open ticket" }, 0, 240], ["e1", "flow", "end", {}, 0, 360]], [["t1", "w1"], ["w1", "a1"], ["a1", "e1"]]), null],
      ["jrn_tourney", "Weekend tournament reminder", "marketing", "draft", mk([["t1", "trigger", "segment_entry", { segment_id: "seg_22" }, 0, 0], ["c1", "condition", "consent", { channel: "app_push" }, 0, 120], ["a1", "action", "send_message", { channel: "app_push", template_id: "tpl_promo_push" }, -150, 240], ["e1", "flow", "end", {}, 150, 240], ["e2", "flow", "end", {}, -150, 360]], [["t1", "c1"], ["c1", "a1", "yes"], ["c1", "e1", "no"], ["a1", "e2"]]), null],
      ["jrn_disc", "Disconnect apology", "service", "draft", mk([["t1", "trigger", "segment_entry", { segment_id: "seg_23" }, 0, 0], ["a1", "action", "send_message", { channel: "inbox", template_id: "tpl_incident_inbox" }, 0, 120], ["e1", "flow", "end", {}, 0, 240]], [["t1", "a1"], ["a1", "e1"]]), null],
      ["jrn_rg", "Protective support follow-up", "protective", "draft", mk([["t1", "trigger", "event_trigger", { event: "self_exclusion_enabled" }, 0, 0], ["a1", "action", "send_message", { channel: "inbox", template_id: "tpl_rg_support" }, 0, 120], ["e1", "flow", "end", {}, 0, 240]], [["t1", "a1"], ["a1", "e1"]]), "rg_protection"],
    ];
    for (const [jid, name, purpose, status, def, cat] of js) {
      run("INSERT INTO journeys (id, org_id, name, description, purpose, status, draft_definition, published_version, strategy_category, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", jid, ORG_ID, name, `${name} (${purpose})`, purpose, status === "draft" ? "draft" : status, def, status === "draft" ? null : 1, cat, "crm@aec.local", iso(50 * D), iso(10 * D));
      if (status !== "draft") run("INSERT INTO journey_versions (journey_id, version, definition, strategy_id, strategy_version, status, published_by, published_at) VALUES (?,?,?,?,?,?,?,?)", jid, 1, def, cat ? `str_${cat}` : null, cat === "provider_monitoring" ? 4 : null, "published", "ops@aec.local", iso(20 * D));
    }
    // KYC journey history: historical v1 published 90d ago with two reminder cohorts (48h control, 24h holdout pilot)
    run("UPDATE journeys SET published_version = 1, status = 'paused' WHERE id = 'jrn_kyc'");
    run("INSERT INTO journey_versions (journey_id, version, definition, strategy_id, strategy_version, status, published_by, published_at) VALUES (?,?,?,?,?,?,?,?)", "jrn_kyc", 1, kyc, "str_kyc_assistance", 3, "published", "ops@aec.local", iso(60 * D));
    const hist = players.filter((p) => p.kyc !== "not_started" && p.reg > 60 * D).slice(0, 900);
    hist.forEach((p, k) => {
      const wait = k < 600 ? 48 : 24;
      const done = R.chance(wait === 48 ? 0.31 : 0.4);
      run("INSERT INTO journey_executions (id, journey_id, version, player_id, status, current_node, strategy_version, history, exit_reason, started_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", `jex_h${k}`, "jrn_kyc", 1, p.id, done ? "exited" : "completed", done ? "w1" : "e2", 3,
        J.str([{ node: "t1", at: iso(R.int(20, 55) * D), note: wait === 24 ? "pilot holdout" : "control", wait_hours: wait }]), done ? "kyc_completed" : null, iso(R.int(20, 55) * D), iso(R.int(1, 19) * D));
    });
    run("UPDATE journeys SET status = 'paused' WHERE id = 'jrn_kyc'");
    run("INSERT INTO journey_node_stats (journey_id, version, node_id, entered, completed, errors) VALUES ('jrn_kyc',1,'t1',900,900,0),('jrn_kyc',1,'a1',900,890,10),('jrn_kyc',1,'w1',890,890,0),('jrn_kyc',1,'c1',890,890,0),('jrn_kyc',1,'e1',306,306,0),('jrn_kyc',1,'a2',584,580,4)");
  })();
  log("journeys");

  // ───── opportunities (50) + approvals history ─────
  d.transaction(() => {
    const cats: Array<[string, string, string]> = [["gaming_provider", "Provider {p} launch failure spike", "wf_provider_failure"], ["kyc", "KYC document upload failures on H5", "wf_kyc_assistance"], ["channel_delivery", "SMS delivery dip on carrier route", "wf_channel_delivery"], ["customer_service", "Unresolved loading complaints backlog", "wf_provider_failure"], ["search", "Search no-result rate up for '{k}'", "wf_provider_failure"], ["entitlement", "Duplicate entitlement attempts blocked", "wf_membership_entitlements"], ["journey", "Journey breakpoint: welcome step drop-off", "wf_kyc_assistance"], ["notification", "Duplicate notifications across SMS + push", "wf_channel_delivery"], ["responsible_gaming", "Protective review requested", "wf_rg_protection"], ["budget", "Budget utilization above forecast", "wf_membership_entitlements"], ["payment", "Payment page error rate elevated", "wf_provider_failure"]];
    for (let k = 0; k < 50; k++) {
      const [cat, title, wf] = cats[k % cats.length];
      const daysAgo = R.int(0, 45);
      const status = daysAgo < 1 ? "new" : R.weighted([["resolved", 55], ["dismissed", 15], ["in_progress", 15], ["new", 15]] as const);
      run(`INSERT INTO opportunities (id, org_id, title, description, category, detected_at, severity, evidence, affected_users, affected_systems, possible_causes, recommended_actions, estimated_impact, risk_class, status, workflow_id, strategy_id, strategy_version, dedupe_key, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        `opp_h${k}`, ORG_ID, title.replace("{p}", PROVIDERS[R.int(0, 19)]).replace("{k}", R.pick(KEYWORDS)), "Detected by Opportunity Discovery Agent (historical record)", cat, iso(daysAgo * D + R.int(0, 20) * H), R.weighted([["low", 30], ["medium", 45], ["high", 20], ["critical", 5]] as const),
        J.str([{ metric: "rate", value: Math.round(R.next() * 1000) / 10 }]), R.int(5, 3000), J.str([cat]), J.str(["Under investigation"]), J.str(["Run associated workflow"]), `${R.int(1, 40)}% of affected flow`, R.pick(["low", "medium", "high"]), status, wf, null, null, `hist:${k}`, iso(daysAgo * D));
    }
    const apr: Array<[string, string, string, string, string, string]> = [["strategy_version", "stv_provider_monitoring_4", "Activate Gaming Provider Failure Response v4", "approved", "low", "ops@aec.local"], ["strategy_version", "stv_membership_entitlements_3", "Activate Membership Entitlement Rules v3", "rejected", "high", "finance@aec.local"], ["campaign", "cmp_04", "Campaign: Weekend tournament", "approved", "medium", "compliance@aec.local"], ["campaign", "cmp_13", "Campaign: Live casino tournament", "pending", "medium", ""], ["template", "tpl_promo_sms_draft", "Template: Festival promo (sms)", "changes_requested", "medium", "compliance@aec.local"], ["strategy_version", "stv_kyc_assistance_2", "Activate KYC Completion Assistance v2", "approved", "low", "ops@aec.local"]];
    apr.forEach(([et, eid, title, st, risk, by], k) => {
      run("INSERT INTO approvals (id, org_id, entity_type, entity_id, title, summary, evidence, risk, status, required_levels, current_level, requested_by, expires_at, created_at, decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", `apr_h${k}`, ORG_ID, et, eid, title, "Historical approval (seed)", "[]", risk, st, risk === "high" ? 2 : 1, 1, "crm@aec.local", new Date(NOW + 3 * D).toISOString(), iso((k + 2) * D), st === "pending" ? null : iso((k + 1) * D));
      run("INSERT INTO approval_history (approval_id, level, action, actor, comment, at) VALUES (?,?,?,?,?,?)", `apr_h${k}`, 0, "requested", "crm@aec.local", null, iso((k + 2) * D));
      if (st !== "pending") run("INSERT INTO approval_history (approval_id, level, action, actor, comment, at) VALUES (?,?,?,?,?,?)", `apr_h${k}`, 1, st === "approved" ? "approved" : st, by, st === "rejected" ? "Budget leakage risk" : null, iso((k + 1) * D));
    });
    run("UPDATE campaigns SET approval_id = 'apr_h3' WHERE id = 'cmp_13'");
  })();
  audit(SYSTEM, "system.seeded", "system", "seed", { customers: N, events: evn, messages: mcount });
  log("done");
  return { customers: N, events: evn, messages: mcount };
}
export const _one = one;
