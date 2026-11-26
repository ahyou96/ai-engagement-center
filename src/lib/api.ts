import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { HttpError } from "./util";

/** Wrap a route handler with uniform error handling. */
export function handler<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  return async (...args: A) => {
    try {
      const out = await fn(...args);
      if (out instanceof Response) return out;
      return NextResponse.json(out ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return NextResponse.json({ error: e.message, details: e.details }, { status: e.status });
      if (e instanceof ZodError) return NextResponse.json({ error: "Validation failed", details: e.flatten() }, { status: 400 });
      console.error(e);
      return NextResponse.json({ error: (e as Error).message ?? "Internal error" }, { status: 500 });
    }
  };
}

export async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  try { return (await req.json()) as T; } catch { throw new HttpError(400, "Invalid JSON body"); }
}

/** Basic in-memory token bucket rate limit (per key). */
const buckets = new Map<string, { tokens: number; at: number }>();
export function rateLimit(key: string, perMinute = 120) {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: perMinute, at: now };
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60000) * perMinute);
  b.at = now;
  if (b.tokens < 1) throw new HttpError(429, "Rate limit exceeded");
  b.tokens -= 1;
  buckets.set(key, b);
}
