import crypto from "node:crypto";
import { one } from "./db";

export const ORG_ID = "org_demo";

export function id(prefix: string) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

/** Platform clock. Supports a simulated offset (journey fast-forward in mock mode). */
export function nowDate(): Date {
  let offset = 0;
  try { offset = one<{ offset_minutes: number }>("SELECT offset_minutes FROM system_clock WHERE id = 1")?.offset_minutes ?? 0; } catch { /* db not ready */ }
  return new Date(Date.now() + offset * 60_000);
}
export const nowIso = () => nowDate().toISOString();
export const daysAgo = (d: number, from = nowDate()) => new Date(from.getTime() - d * 86_400_000).toISOString();
export const hoursAgo = (h: number, from = nowDate()) => new Date(from.getTime() - h * 3_600_000).toISOString();
export const addHours = (iso: string, h: number) => new Date(new Date(iso).getTime() + h * 3_600_000).toISOString();

/** Deterministic PRNG (mulberry32). */
export function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => Math.floor(next() * (max - min + 1)) + min,
    pick: <T,>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)],
    chance: (p: number) => next() < p,
    weighted: <T,>(items: readonly (readonly [T, number])[]): T => {
      const total = items.reduce((s, [, w]) => s + w, 0);
      let r = next() * total;
      for (const [v, w] of items) { if ((r -= w) <= 0) return v; }
      return items[items.length - 1][0];
    },
  };
}

export function hashStable(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/** Deterministic bucket in [0,1) for experiment allocation. */
export function bucket(key: string) {
  return parseInt(hashStable(key).slice(0, 8), 16) / 0x100000000;
}

export const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
export const pct = (num: number, den: number) => (den ? round((num / den) * 100, 1) : 0);

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}
