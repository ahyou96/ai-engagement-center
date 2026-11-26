"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Lang, translate } from "@/lib/i18n";

export class ApiError extends Error { constructor(public status: number, message: string, public details?: unknown) { super(message); } }

/** JSON fetch helper for /api routes. Throws ApiError with server message/details. */
export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const res = await fetch(`/api/${path.replace(/^\//, "")}`, { method: init?.method ?? (init?.body ? "POST" : "GET"), headers: init?.body ? { "content-type": "application/json" } : undefined, body: init?.body ? JSON.stringify(init.body) : undefined, signal: init?.signal, cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { if (res.status === 401 && typeof window !== "undefined") window.location.href = "/login"; throw new ApiError(res.status, data.error ?? res.statusText, data.details); }
  return data as T;
}

/** Data hook with loading/error/refresh. Pass null path to skip. */
export function useApi<T = unknown>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) { setLoading(false); return; }
    const ctrl = new AbortController();
    setLoading(true);
    api<T>(path, { signal: ctrl.signal }).then((d) => { setData(d); setError(null); }).catch((e) => { if (e.name !== "AbortError") setError(e); }).finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, n, ...deps]);
  const refresh = useCallback(() => setN((x) => x + 1), []);
  return { data, error, loading, refresh, setData };
}

export type StreamEvent = { seq: number; topic: string; ref_id: string | null; type: string; payload: Record<string, unknown>; at: string };
/** Subscribe to the platform SSE stream (auto-reconnects with Last-Event-ID; de-duplicated by seq). */
export function useStream(path: string | null, onEvent: (e: StreamEvent) => void) {
  const cb = useRef(onEvent); cb.current = onEvent;
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!path) return;
    let last = 0;
    const es = new EventSource(`/api/${path}`);
    const handle = (m: MessageEvent) => { try { const e = JSON.parse(m.data) as StreamEvent; if (e.seq <= last) return; last = e.seq; cb.current(e); } catch { /* ignore */ } };
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = handle;
    const types = ["run.started", "node.started", "node.completed", "node.failed", "node.retrying", "tool.started", "tool.completed", "tool.failed", "run.waiting_approval", "run.resumed", "run.paused", "run.finished", "run.halted", "run.recovered", "notification", "approval.created", "approval.updated", "strategy.activated", "strategy.candidate", "strategy.evaluated", "strategy.rolled_back", "segment.membership_changed", "messages.sent", "delivery.event", "events.ingested", "journey.enrolled", "journey.exited", "journey.published", "journey.status", "compliance.protection_applied", "emergency_stop", "offers.issued", "campaign.executed"];
    for (const t of types) es.addEventListener(t, handle as EventListener);
    return () => es.close();
  }, [path]);
  return connected;
}

// ───── global UI state (date range, filters, language, toasts, copilot drawer) ─────
export type Toast = { id: number; kind: "success" | "error" | "info" | "warning"; title: string; body?: string };
type G = {
  days: number; setDays: (d: number) => void; lang: Lang; setLang: (l: Lang) => void; t: (k: string) => string;
  toast: (t: Omit<Toast, "id">) => void; openCopilot: (prompt?: string) => void; me: Me | null; refreshMe: () => void;
};
export type Me = { id: string; email: string; name: string; role_id: string; permissions: string[]; emergency_stop: boolean; ai_provider: string };
export const GlobalCtx = createContext<G>(null as unknown as G);
export const useGlobal = () => useContext(GlobalCtx);
export const can = (me: Me | null, p: string) => !!me?.permissions.includes(p);

export function useT() { const { lang } = useGlobal(); return (k: string) => translate(lang, k); }

export function downloadCsv(name: string, rows: Array<Record<string, unknown>>) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => { const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = `${name}.csv`; a.click(); URL.revokeObjectURL(a.href);
}

export const fmt = {
  int: (v: unknown) => (v == null || v === "" ? "–" : Number(v).toLocaleString()),
  pct: (v: unknown, d = 1) => (v == null ? "–" : `${(Number(v) * 100).toFixed(d)}%`),
  money: (v: unknown) => (v == null ? "–" : `₱${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`),
  ms: (v: unknown) => (v == null ? "–" : `${Number(v).toLocaleString()} ms`),
  date: (v: unknown) => (v ? new Date(String(v)).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "–"),
  day: (v: unknown) => (v ? new Date(String(v)).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "–"),
  ago: (v: unknown) => { if (!v) return "–"; const s = (Date.now() - new Date(String(v)).getTime()) / 1000; if (s < 60) return `${Math.max(0, Math.round(s))}s ago`; if (s < 3600) return `${Math.round(s / 60)}m ago`; if (s < 86400) return `${Math.round(s / 3600)}h ago`; return `${Math.round(s / 86400)}d ago`; },
};
