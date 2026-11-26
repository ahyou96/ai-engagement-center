"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, LayoutDashboard, Radar, Users, Gift, Megaphone, Workflow, Send, BarChart3, Sparkles, ShieldCheck, Settings, Search, Bell, Moon, Sun, PanelLeftClose, PanelLeftOpen, LogOut, OctagonAlert, Languages, X, CheckCircle2, AlertTriangle, Info, Menu } from "lucide-react";
import { api, GlobalCtx, Me, Toast, useApi, useStream, fmt } from "./hooks";
import { Lang, translate } from "@/lib/i18n";
import { Badge, Button, cx, Confirm } from "./ui";
import { CopilotPanel } from "./copilot";

const NAV = [
  { href: "/copilot", key: "copilot", icon: Bot }, { href: "/overview", key: "overview", icon: LayoutDashboard }, { href: "/opportunities", key: "opportunities", icon: Radar },
  { href: "/audience", key: "audience", icon: Users }, { href: "/offers", key: "offers", icon: Gift }, { href: "/campaigns", key: "campaigns", icon: Megaphone },
  { href: "/journeys", key: "journeys", icon: Workflow }, { href: "/channels", key: "channels", icon: Send }, { href: "/analytics", key: "analytics", icon: BarChart3 },
  { href: "/optimizer", key: "optimizer", icon: Sparkles }, { href: "/compliance", key: "compliance", icon: ShieldCheck }, { href: "/settings", key: "settings", icon: Settings },
];
const DAYS = [1, 7, 14, 30, 90];

function ls(k: string, d: string) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
function lsSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } }

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname(); const router = useRouter();
  const [collapsed, setCollapsed] = useState(false); const [mobileNav, setMobileNav] = useState(false);
  const [days, setDaysS] = useState(7); const [lang, setLangS] = useState<Lang>("en"); const [dark, setDark] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]); const [copilot, setCopilot] = useState<{ open: boolean; prompt?: string; n: number }>({ open: false, n: 0 });
  const [palette, setPalette] = useState(false); const [notifOpen, setNotifOpen] = useState(false); const [estopConfirm, setEstopConfirm] = useState(false);
  const me = useApi<Me>("auth/me"); const notifs = useApi<{ items: Array<{ id: number; title: string; body: string; link: string; severity: string; read: number; at: string }>; unread: number }>("notifications");

  useEffect(() => { setCollapsed(ls("aec-nav", "0") === "1"); setDaysS(Number(ls("aec-days", "7"))); setLangS(ls("aec-lang", "en") as Lang); setDark(document.documentElement.classList.contains("dark")); }, []);
  useEffect(() => { document.documentElement.lang = lang === "zh" ? "zh-CN" : "en"; }, [lang]);
  const toast = useCallback((t: Omit<Toast, "id">) => { const id = Date.now() + Math.random(); setToasts((x) => [...x.slice(-3), { ...t, id }]); setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), 5000); }, []);
  const g = useMemo(() => ({
    days, setDays: (d: number) => { setDaysS(d); lsSet("aec-days", String(d)); }, lang, setLang: (l: Lang) => { setLangS(l); lsSet("aec-lang", l); }, t: (k: string) => translate(lang, k),
    toast, openCopilot: (prompt?: string) => setCopilot((c) => ({ open: true, prompt, n: c.n + 1 })), me: me.data, refreshMe: me.refresh,
  }), [days, lang, toast, me.data, me.refresh]);
  const t = g.t;

  useStream("stream?topics=notifications,system", (e) => {
    if (e.type === "notification") { notifs.refresh(); const p = e.payload as { title: string; body: string; severity: string }; toast({ kind: p.severity === "critical" ? "error" : p.severity === "warning" ? "warning" : p.severity === "success" ? "success" : "info", title: p.title, body: p.body }); }
    if (e.type === "emergency_stop") me.refresh();
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette(true); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") { e.preventDefault(); setCopilot((c) => ({ open: !c.open, n: c.n })); }
    };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  }, []);
  const toggleTheme = () => { const d = !dark; setDark(d); document.documentElement.classList.toggle("dark", d); lsSet("aec-theme", d ? "dark" : "light"); };
  const estop = me.data?.emergency_stop;
  const canEstop = me.data?.permissions.includes("workflows.emergency_stop");
  const doEstop = async () => { try { await api("system/emergency-stop", { body: { on: !estop } }); me.refresh(); } catch (e) { toast({ kind: "error", title: (e as Error).message }); } setEstopConfirm(false); };

  const nav = (
    <nav className="flex-1 overflow-y-auto scroll-thin py-2 px-2 space-y-0.5" aria-label="Main">
      {NAV.map(({ href, key, icon: Icon }) => {
        const active = path === href || path.startsWith(href + "/");
        return <Link key={href} href={href} onClick={() => setMobileNav(false)} title={collapsed ? t(key) : undefined} aria-current={active ? "page" : undefined}
          className={cx("flex items-center gap-2.5 rounded-md px-2.5 h-8 text-[13px] transition-colors", active ? "bg-accent-soft text-accent font-medium" : "text-muted hover:text-fg hover:bg-panel-2", collapsed && "justify-center px-0")}>
          <Icon size={16} className="shrink-0" />{!collapsed && <span className="truncate">{t(key)}</span>}
        </Link>;
      })}
    </nav>
  );

  return (
    <GlobalCtx.Provider value={g}>
      <div className="flex h-dvh overflow-hidden">
        <aside className={cx("hidden md:flex flex-col border-r border-border bg-panel transition-[width] shrink-0", collapsed ? "w-[52px]" : "w-[216px]")}>
          <div className={cx("flex items-center h-12 border-b border-border px-3 gap-2", collapsed && "justify-center px-0")}>
            <div className="h-6 w-6 rounded-md bg-accent text-accent-fg grid place-items-center text-[11px] font-bold shrink-0">AE</div>
            {!collapsed && <div className="leading-tight min-w-0"><div className="font-semibold text-[13px] truncate">AI Engagement Center</div><div className="text-[10.5px] text-faint truncate">{t("mock_mode")}</div></div>}
          </div>
          {nav}
          <button onClick={() => { setCollapsed(!collapsed); lsSet("aec-nav", collapsed ? "0" : "1"); }} className="h-10 border-t border-border flex items-center justify-center text-muted hover:text-fg" aria-label="Toggle navigation">{collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button>
        </aside>
        {mobileNav && <div className="fixed inset-0 z-40 md:hidden"><div className="absolute inset-0 bg-black/40" onClick={() => setMobileNav(false)} /><aside className="relative w-64 h-full bg-panel border-r border-border flex flex-col"><div className="h-12 flex items-center px-3 font-semibold border-b border-border">AI Engagement Center</div>{nav}</aside></div>}

        <div className="flex-1 flex flex-col min-w-0">
          {estop && <div className="bg-bad text-white text-xs font-semibold px-4 py-1.5 flex items-center gap-2"><OctagonAlert size={14} />{t("emergency_active")} — automated execution halted; protective, security and regulatory messages remain allowed.{canEstop && <button className="underline ml-auto" onClick={() => setEstopConfirm(true)}>Clear</button>}</div>}
          <header className="h-12 border-b border-border bg-panel flex items-center gap-2 px-3 shrink-0">
            <button className="md:hidden p-1.5" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu size={18} /></button>
            <button onClick={() => setPalette(true)} className="flex items-center gap-2 h-8 px-2.5 rounded-md border border-border bg-panel-2 text-faint text-[13px] w-auto sm:w-full max-w-[340px] hover:border-border-strong shrink-0 sm:shrink" aria-label="Open command palette">
              <Search size={14} className="shrink-0" /><span className="truncate flex-1 text-left hidden sm:inline">{t("search")}</span><kbd className="hidden sm:inline text-[10px] border border-border rounded px-1">⌘K</kbd>
            </button>
            <div className="flex-1" />
            <div className="hidden sm:flex items-center rounded-md border border-border overflow-hidden" role="group" aria-label="Date range">
              {DAYS.map((d) => <button key={d} onClick={() => g.setDays(d)} className={cx("h-7 px-2 text-xs", days === d ? "bg-accent-soft text-accent font-medium" : "text-muted hover:text-fg")}>{d === 1 ? "24h" : `${d}d`}</button>)}
            </div>
            <div className="hidden sm:block"><Button size="sm" variant="subtle" onClick={() => g.openCopilot()}><Bot size={14} />{t("ask_copilot")}</Button></div>
            <button className="sm:hidden p-1.5 rounded-md text-accent" aria-label={t("ask_copilot")} onClick={() => g.openCopilot()}><Bot size={16} /></button>
            <div className="relative">
              <button onClick={() => setNotifOpen(!notifOpen)} className="relative p-1.5 rounded-md hover:bg-panel-2 text-muted" aria-label={t("notifications")}><Bell size={16} />{!!notifs.data?.unread && <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-bad text-white text-[10px] grid place-items-center">{notifs.data.unread > 99 ? "99+" : notifs.data.unread}</span>}</button>
              {notifOpen && <div className="absolute right-0 top-9 z-40 w-[360px] max-w-[90vw] rounded-lg border border-border bg-panel shadow-xl">
                <div className="flex items-center justify-between px-3 h-10 border-b border-border"><span className="font-semibold text-[13px]">{t("notifications")}</span><button className="text-xs text-accent" onClick={async () => { await api("notifications/read", { body: {} }); notifs.refresh(); }}>{t("mark_read")}</button></div>
                <div className="max-h-[420px] overflow-y-auto scroll-thin">{(notifs.data?.items ?? []).map((n) => (
                  <button key={n.id} onClick={() => { setNotifOpen(false); if (n.link) router.push(n.link); }} className={cx("w-full text-left px-3 py-2.5 border-b border-border hover:bg-panel-2", !n.read && "bg-accent-soft/40")}>
                    <div className="flex items-center gap-2"><Badge tone={n.severity === "critical" ? "bad" : n.severity === "warning" ? "warn" : n.severity === "success" ? "ok" : "info"}>{n.severity}</Badge><span className="text-[12.5px] font-medium truncate">{n.title}</span></div>
                    <div className="text-xs text-muted mt-0.5 line-clamp-2">{n.body}</div><div className="text-[10.5px] text-faint mt-0.5">{fmt.ago(n.at)}</div>
                  </button>))}{!notifs.data?.items.length && <div className="p-6 text-center text-xs text-muted">{t("empty")}</div>}</div>
              </div>}
            </div>
            <button onClick={() => g.setLang(lang === "en" ? "zh" : "en")} className="p-1.5 rounded-md hover:bg-panel-2 text-muted text-xs flex items-center gap-1" aria-label={t("language")}><Languages size={15} />{lang === "en" ? "中" : "EN"}</button>
            <button onClick={toggleTheme} className="p-1.5 rounded-md hover:bg-panel-2 text-muted" aria-label={t("theme")}>{dark ? <Sun size={16} /> : <Moon size={16} />}</button>
            {canEstop && <button onClick={() => setEstopConfirm(true)} className={cx("p-1.5 rounded-md", estop ? "bg-bad text-white" : "text-bad hover:bg-bad-soft")} title={t("emergency_stop")} aria-label={t("emergency_stop")}><OctagonAlert size={16} /></button>}
            <div className="hidden lg:flex items-center gap-2 pl-2 border-l border-border ml-1">
              <div className="leading-tight text-right"><div className="text-xs font-medium">{me.data?.name}</div><div className="text-[10.5px] text-faint">{me.data?.role_id?.replace("_", " ")}</div></div>
              <button aria-label={t("sign_out")} title={t("sign_out")} className="p-1.5 rounded-md hover:bg-panel-2 text-muted" onClick={async () => { await api("auth/logout", { body: {} }); window.location.href = "/login"; }}><LogOut size={15} /></button>
            </div>
          </header>
          <main className="flex-1 overflow-y-auto scroll-thin"><div className="mx-auto max-w-[1440px] px-4 md:px-6 py-5">{children}</div></main>
        </div>
        <CopilotPanel open={copilot.open} prompt={copilot.prompt} nonce={copilot.n} onClose={() => setCopilot((c) => ({ ...c, open: false }))} />
      </div>
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      <Confirm open={estopConfirm} onClose={() => setEstopConfirm(false)} onConfirm={doEstop} danger={!estop} confirmLabel={estop ? "Clear emergency stop" : "Activate emergency stop"} title={estop ? "Clear emergency stop?" : "Activate EMERGENCY STOP?"}
        body={estop ? "Workflows may start again. Paused journeys and campaigns stay paused until resumed individually." : "All running AI workflows will be stopped, active journeys and approved campaigns paused, and only simulations may run. Protective, security and regulatory messages remain allowed. This is recorded in the audit log."} />
      <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 w-[340px] max-w-[calc(100vw-2rem)]" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className="rounded-lg border border-border bg-panel shadow-lg px-3 py-2.5 flex gap-2.5 items-start">
            {x.kind === "success" ? <CheckCircle2 size={16} className="text-ok mt-0.5" /> : x.kind === "error" ? <AlertTriangle size={16} className="text-bad mt-0.5" /> : x.kind === "warning" ? <AlertTriangle size={16} className="text-warn mt-0.5" /> : <Info size={16} className="text-info mt-0.5" />}
            <div className="flex-1 min-w-0"><div className="text-[13px] font-medium">{x.title}</div>{x.body && <div className="text-xs text-muted mt-0.5 line-clamp-3">{x.body}</div>}</div>
            <button aria-label="Dismiss" onClick={() => setToasts((t) => t.filter((y) => y.id !== x.id))} className="text-faint hover:text-fg"><X size={14} /></button>
          </div>))}
      </div>
    </GlobalCtx.Provider>
  );
}

function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter(); const [q, setQ] = useState(""); const [i, setI] = useState(0);
  const [results, setResults] = useState<Array<{ type: string; label: string; href: string }>>([]);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  useEffect(() => { if (q.length < 2) { setResults([]); return; } const c = new AbortController(); const tm = setTimeout(() => api<{ results: Array<{ type: string; label: string; href: string }> }>(`search?q=${encodeURIComponent(q)}`, { signal: c.signal }).then((r) => setResults(r.results)).catch(() => {}), 150); return () => { clearTimeout(tm); c.abort(); }; }, [q]);
  const commands = [
    ...NAV.map((n) => ({ type: "page", label: `Go to ${translate("en", n.key)}`, href: n.href })),
    { type: "action", label: "Run: Gaming provider failure workflow", href: "/opportunities?run=provider_failure" }, { type: "action", label: "Run: KYC assistance workflow", href: "/opportunities?run=kyc_assistance" },
    { type: "action", label: "Create segment with AI", href: "/audience?tab=ai" }, { type: "action", label: "New campaign", href: "/campaigns?new=1" }, { type: "action", label: "Review approvals", href: "/compliance?tab=approvals" },
    { type: "action", label: "Offer decision simulator", href: "/offers?tab=simulator" },
  ].filter((c) => !q || c.label.toLowerCase().includes(q.toLowerCase()));
  const items = [...results, ...commands].slice(0, 14);
  const go = (href: string) => { onClose(); router.push(href); };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-[560px] rounded-xl border border-border bg-panel shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-3 h-12 border-b border-border"><Search size={16} className="text-faint" />
          <input ref={ref} value={q} onChange={(e) => { setQ(e.target.value); setI(0); }} placeholder="Search players, segments, campaigns, journeys… or type a command"
            onKeyDown={(e) => { if (e.key === "Escape") onClose(); if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(items.length - 1, x + 1)); } if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(0, x - 1)); } if (e.key === "Enter" && items[i]) go(items[i].href); }}
            className="flex-1 bg-transparent outline-none text-[14px]" aria-label="Command" />
        </div>
        <ul className="max-h-[50vh] overflow-y-auto scroll-thin py-1" role="listbox">
          {items.map((it, k) => <li key={`${it.href}${k}`} role="option" aria-selected={k === i}><button onMouseEnter={() => setI(k)} onClick={() => go(it.href)} className={cx("w-full flex items-center gap-2 px-3 py-2 text-left text-[13px]", k === i && "bg-panel-2")}><Badge>{it.type}</Badge><span className="truncate">{it.label}</span></button></li>)}
          {!items.length && <li className="px-3 py-6 text-center text-xs text-muted">No matches</li>}
        </ul>
      </div>
    </div>
  );
}
