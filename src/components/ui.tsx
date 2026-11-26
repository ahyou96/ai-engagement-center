"use client";
import { clsx } from "clsx";
import { Fragment, ReactNode, useEffect, useMemo, useState } from "react";
import { X, AlertTriangle, Inbox, ChevronUp, ChevronDown, Download, Info } from "lucide-react";
import { downloadCsv, useT } from "./hooks";

export const cx = clsx;

export function Button({ children, variant = "default", size = "md", className, loading, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "ghost" | "danger" | "subtle"; size?: "sm" | "md"; loading?: boolean }) {
  return (
    <button {...p} disabled={p.disabled || loading} className={cx("inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
      size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-[13px]",
      variant === "primary" && "bg-accent text-accent-fg hover:opacity-90",
      variant === "default" && "border border-border bg-panel hover:bg-panel-2 text-fg",
      variant === "ghost" && "hover:bg-panel-2 text-muted hover:text-fg",
      variant === "subtle" && "bg-accent-soft text-accent hover:opacity-90",
      variant === "danger" && "bg-bad text-white hover:opacity-90", className)}>
      {loading && <span className="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" />}{children}
    </button>
  );
}

export function Card({ title, actions, children, className, pad = true, subtitle }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={cx("rounded-lg border border-border bg-panel", className)}>
      {(title || actions) && <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5 min-h-11"><div className="min-w-0"><h3 className="text-[13px] font-semibold truncate">{title}</h3>{subtitle && <p className="text-xs text-muted truncate">{subtitle}</p>}</div><div className="flex items-center gap-1.5 shrink-0">{actions}</div></header>}
      <div className={pad ? "p-4" : ""}>{children}</div>
    </section>
  );
}

const TONES: Record<string, string> = {
  neutral: "bg-panel-2 text-muted border-border", ok: "bg-ok-soft text-ok border-transparent", warn: "bg-warn-soft text-warn border-transparent", bad: "bg-bad-soft text-bad border-transparent", info: "bg-info-soft text-info border-transparent", accent: "bg-accent-soft text-accent border-transparent",
};
export function Badge({ children, tone = "neutral", className, title }: { children: ReactNode; tone?: keyof typeof TONES | string; className?: string; title?: string }) {
  return <span title={title} className={cx("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium border whitespace-nowrap", TONES[tone] ?? TONES.neutral, className)}>{children}</span>;
}
const STATUS_TONE: Record<string, string> = {
  active: "ok", completed: "ok", approved: "ok", resolved: "ok", delivered: "ok", issued: "ok", redeemed: "ok", published: "ok", verified: "ok", healthy: "ok", connected_mock: "info", mock_verified: "info", read: "ok", clicked: "ok", linked: "ok",
  running: "info", in_progress: "info", testing: "info", candidate: "accent", claimed: "info", sent: "info", new: "accent", draft: "neutral", waiting: "info", scheduled: "info", in_review: "info", simulated: "neutral",
  pending: "warn", pending_approval: "warn", waiting_approval: "warn", paused: "warn", degraded: "warn", changes_requested: "warn", medium: "warn", warning: "warn", at_risk: "warn",
  failed: "bad", rejected: "bad", stopped: "bad", cancelled: "neutral", expired: "neutral", error: "bad", high: "bad", critical: "bad", rolled_back: "bad", down: "bad", blocked: "bad", reversed: "bad",
  archived: "neutral", dismissed: "neutral", skipped: "neutral", superseded: "neutral", exited: "neutral", low: "ok", info: "info", not_configured: "neutral",
};
export function Status({ value, className }: { value: string | null | undefined; className?: string }) {
  const v = String(value ?? "–");
  return <Badge tone={STATUS_TONE[v] ?? "neutral"} className={className}>{v === "running" || v === "waiting" ? <span className="h-1.5 w-1.5 rounded-full bg-current pulse" /> : null}{v.replace(/_/g, " ")}</Badge>;
}

export function Stat({ label, value, prev, hint, format = (v: unknown) => String(v), invert, onClick, loading }: { label: string; value: unknown; prev?: unknown; hint?: string; format?: (v: unknown) => string; invert?: boolean; onClick?: () => void; loading?: boolean }) {
  const delta = prev != null && value != null && Number(prev) !== 0 ? (Number(value) - Number(prev)) / Math.abs(Number(prev)) : null;
  const good = delta == null ? null : invert ? delta < 0 : delta > 0;
  return (
    <button onClick={onClick} title={hint} className={cx("text-left rounded-lg border border-border bg-panel px-3.5 py-3 min-w-0 transition-colors", onClick && "hover:border-border-strong cursor-pointer")} disabled={!onClick}>
      <div className="flex items-center gap-1 text-[11.5px] text-muted truncate">{label}{hint && <Info size={11} className="text-faint shrink-0" />}</div>
      {loading ? <div className="skeleton h-6 w-20 mt-1.5" /> : <div className="mt-1 text-[20px] font-semibold tracking-tight tabular-nums truncate">{format(value)}</div>}
      {delta != null && !loading && <div className={cx("text-[11px] mt-0.5 tabular-nums", good ? "text-ok" : "text-bad")}>{delta > 0 ? "▲" : "▼"} {Math.abs(delta * 100).toFixed(1)}% <span className="text-faint">vs prev</span></div>}
    </button>
  );
}

export function Tabs({ tabs, value, onChange, className }: { tabs: Array<{ key: string; label: ReactNode; count?: number }>; value: string; onChange: (k: string) => void; className?: string }) {
  return (
    <div role="tablist" className={cx("flex gap-1 border-b border-border overflow-x-auto scroll-thin", className)}>
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={value === t.key} onClick={() => onChange(t.key)} className={cx("px-3 py-2 text-[13px] whitespace-nowrap border-b-2 -mb-px transition-colors", value === t.key ? "border-accent text-fg font-medium" : "border-transparent text-muted hover:text-fg")}>
          {t.label}{t.count != null && <span className="ml-1.5 text-[11px] text-faint">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Input(p: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cx("h-8 rounded-md border border-border bg-panel px-2.5 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-[var(--ring)] placeholder:text-faint", p.className)} />;
}
export function Textarea(p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} className={cx("rounded-md border border-border bg-panel px-2.5 py-2 text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-[var(--ring)] placeholder:text-faint", p.className)} />;
}
export function Select({ options, className, ...p }: React.SelectHTMLAttributes<HTMLSelectElement> & { options: Array<{ value: string; label: string } | string> }) {
  return (
    <select {...p} className={cx("h-8 rounded-md border border-border bg-panel px-2 text-[13px] outline-none focus:border-accent", className)}>
      {options.map((o) => typeof o === "string" ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="flex flex-col gap-1 text-xs"><span className="text-muted font-medium">{label}</span>{children}{hint && <span className="text-faint">{hint}</span>}</label>;
}
export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} className={cx("relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50", checked ? "bg-accent" : "bg-border-strong")}>
      <span className={cx("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-4" : "translate-x-0.5")} />
    </button>
  );
}

export function Skeleton({ className }: { className?: string }) { return <div className={cx("skeleton", className)} />; }
export function Loading({ rows = 4 }: { rows?: number }) { return <div className="space-y-2">{Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>; }
export function Empty({ title, body, action }: { title?: string; body?: string; action?: ReactNode }) {
  const t = useT();
  return <div className="flex flex-col items-center justify-center text-center py-10 gap-2 text-muted"><Inbox size={28} className="text-faint" /><div className="font-medium text-fg">{title ?? t("empty")}</div>{body && <div className="text-xs max-w-sm">{body}</div>}{action}</div>;
}
export function ErrorState({ error, onRetry }: { error: { message: string } | null; onRetry?: () => void }) {
  const t = useT();
  if (!error) return null;
  return <div className="flex items-center gap-3 rounded-md border border-bad/30 bg-bad-soft px-3 py-2.5 text-bad text-[13px]"><AlertTriangle size={16} /><div className="flex-1">{t("error")}: {error.message}</div>{onRetry && <Button size="sm" onClick={onRetry}>{t("retry")}</Button>}</div>;
}
export function Notice({ tone = "info", children, className }: { tone?: "info" | "warn" | "bad" | "ok"; children: ReactNode; className?: string }) {
  return <div className={cx("rounded-md px-3 py-2 text-[12.5px] border", tone === "info" && "bg-info-soft text-info border-transparent", tone === "warn" && "bg-warn-soft text-warn border-transparent", tone === "bad" && "bg-bad-soft text-bad border-transparent", tone === "ok" && "bg-ok-soft text-ok border-transparent", className)}>{children}</div>;
}

/** Slide-over side panel (contextual details). Esc closes. */
export function Drawer({ open, onClose, title, children, width = 560, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: number; footer?: ReactNode }) {
  useEffect(() => { if (!open) return; const h = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative h-full bg-panel border-l border-border shadow-xl flex flex-col w-full" style={{ maxWidth: width }}>
        <div className="flex items-center justify-between px-4 h-12 border-b border-border shrink-0"><div className="font-semibold truncate">{title}</div><button aria-label="Close" onClick={onClose} className="p-1 rounded hover:bg-panel-2"><X size={16} /></button></div>
        <div className="flex-1 overflow-y-auto scroll-thin p-4">{children}</div>
        {footer && <div className="border-t border-border p-3 flex justify-end gap-2 shrink-0">{footer}</div>}
      </div>
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, width = 480 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => { if (!open) return; const h = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full rounded-lg border border-border bg-panel shadow-xl" style={{ maxWidth: width }}>
        <div className="flex items-center justify-between px-4 h-11 border-b border-border"><div className="font-semibold">{title}</div><button aria-label="Close" onClick={onClose} className="p-1 rounded hover:bg-panel-2"><X size={16} /></button></div>
        <div className="p-4 max-h-[70vh] overflow-y-auto scroll-thin">{children}</div>
        {footer && <div className="border-t border-border p-3 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

/** Confirmation dialog for irreversible / restricted actions. */
export function Confirm({ open, title, body, confirmLabel = "Confirm", danger, onConfirm, onClose, loading }: { open: boolean; title: string; body: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onClose: () => void; loading?: boolean }) {
  return <Modal open={open} onClose={onClose} title={title} footer={<><Button onClick={onClose}>Cancel</Button><Button variant={danger ? "danger" : "primary"} onClick={onConfirm} loading={loading}>{confirmLabel}</Button></>}><div className="text-[13px] text-muted">{body}</div></Modal>;
}

export type Col<T> = { key: string; label: ReactNode; render?: (row: T) => ReactNode; sort?: (row: T) => string | number; className?: string; align?: "right" | "left" };
/** Sortable, filterable, paginated data table with CSV export. */
export function DataTable<T extends Record<string, unknown>>({ rows, cols, onRow, pageSize = 25, search, exportName, empty, dense, rowKey }: { rows: T[]; cols: Col<T>[]; onRow?: (r: T) => void; pageSize?: number; search?: (r: T) => string; exportName?: string; empty?: ReactNode; dense?: boolean; rowKey?: (r: T, i: number) => string }) {
  const [q, setQ] = useState(""); const [sort, setSort] = useState<{ k: string; dir: 1 | -1 } | null>(null); const [page, setPage] = useState(0);
  const t = useT();
  const filtered = useMemo(() => {
    let r = rows;
    if (q && search) r = r.filter((x) => search(x).toLowerCase().includes(q.toLowerCase()));
    if (sort) { const c = cols.find((c) => c.key === sort.k); const f = c?.sort ?? ((x: T) => x[sort.k] as string | number); r = [...r].sort((a, b) => { const A = f(a), B = f(b); return (A > B ? 1 : A < B ? -1 : 0) * sort.dir; }); }
    return r;
  }, [rows, q, sort, cols, search]);
  useEffect(() => setPage(0), [q, rows]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const view = filtered.slice(page * pageSize, page * pageSize + pageSize);
  return (
    <div className="min-w-0">
      {(search || exportName) && (
        <div className="flex items-center gap-2 mb-2">
          {search && <Input placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} className="w-56" aria-label="Filter rows" />}
          <div className="flex-1" />
          <span className="text-xs text-faint">{filtered.length.toLocaleString()} rows</span>
          {exportName && <Button size="sm" variant="ghost" onClick={() => downloadCsv(exportName, filtered as Record<string, unknown>[])}><Download size={13} />{t("export")}</Button>}
        </div>
      )}
      <div className="overflow-x-auto scroll-thin rounded-md border border-border">
        <table className="w-full text-[12.5px]">
          <thead className="bg-panel-2 text-muted">
            <tr>{cols.map((c) => (
              <th key={c.key} scope="col" className={cx("px-3 py-2 font-medium text-left whitespace-nowrap select-none", c.align === "right" && "text-right", c.className)}>
                <button className="inline-flex items-center gap-0.5 hover:text-fg" onClick={() => setSort((s) => (s?.k === c.key ? { k: c.key, dir: s.dir === 1 ? -1 : 1 } : { k: c.key, dir: -1 }))}>{c.label}{sort?.k === c.key && (sort.dir === 1 ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}</button>
              </th>))}</tr>
          </thead>
          <tbody>
            {view.map((r, i) => (
              <tr key={rowKey ? rowKey(r, i) : String(r.id ?? r.player_id ?? r.key ?? i)} onClick={onRow ? () => onRow(r) : undefined} tabIndex={onRow ? 0 : undefined} onKeyDown={onRow ? (e) => e.key === "Enter" && onRow(r) : undefined} className={cx("border-t border-border", onRow && "cursor-pointer hover:bg-panel-2 focus:bg-panel-2")}>
                {cols.map((c) => <td key={c.key} className={cx("px-3 align-middle", dense ? "py-1.5" : "py-2", c.align === "right" && "text-right tabular-nums", c.className)}>{c.render ? c.render(r) : String(r[c.key] ?? "–")}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {!view.length && (empty ?? <Empty />)}
      </div>
      {pages > 1 && <div className="flex items-center justify-end gap-2 mt-2 text-xs text-muted"><Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>Prev</Button><span>{page + 1} / {pages}</span><Button size="sm" variant="ghost" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next</Button></div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return <div className="flex flex-wrap items-end justify-between gap-3 mb-4"><div className="min-w-0"><h1 className="text-[19px] font-semibold tracking-tight">{title}</h1>{subtitle && <p className="text-[12.5px] text-muted mt-0.5">{subtitle}</p>}</div><div className="flex flex-wrap items-center gap-2">{actions}</div></div>;
}

export function KV({ items }: { items: Array<[ReactNode, ReactNode]> }) {
  return <dl className="grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">{items.map(([k, v], i) => <Fragment key={i}><dt className="text-muted">{k}</dt><dd className="min-w-0 break-words">{v}</dd></Fragment>)}</dl>;
}

export function JsonView({ value }: { value: unknown }) {
  return <pre className="text-[11.5px] font-mono bg-panel-2 border border-border rounded-md p-2.5 overflow-auto max-h-80 scroll-thin whitespace-pre-wrap break-all">{JSON.stringify(value, null, 2)}</pre>;
}

/** Labels the epistemic status of a figure (verified / estimate / assumption / unavailable). */
export function Provenance({ kind }: { kind: "verified" | "estimate" | "assumption" | "unavailable" | string }) {
  const tone = kind === "verified" ? "ok" : kind === "estimate" ? "info" : kind === "assumption" ? "warn" : "neutral";
  return <Badge tone={tone}>{kind}</Badge>;
}
