"use client";
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Bot, Download, RefreshCw, Activity } from "lucide-react";
import { useApi, useGlobal, useStream, fmt, downloadCsv } from "@/components/hooks";
import { Badge, Button, Card, DataTable, Drawer, ErrorState, KV, PageHeader, Provenance, Select, Skeleton, Stat, cx } from "@/components/ui";
import { Chart, bar, line, pie } from "@/components/chart";

type Metric = { key: string; label: string; value: number | null; prev?: number | null; format: "int" | "pct" | "money" | "ms" | "float"; definition: string; formula: string; source: string };
type Overview = {
  customer: Metric[]; gaming: Metric[]; engagement: Metric[]; ai: Metric[]; offers: Metric[]; computed_ms: number;
  charts: { daily: Array<{ d: string; active: number; ok: number; fail: number }>; msgs: Array<{ d: string; sent: number; delivered: number }>; lifecycle: Array<{ k: string; n: number }>; providers: Array<{ id: string; name: string; launches: number; failures: number; avg_load: number }>; channels: Array<{ channel: string; total: number; delivered: number; read: number; clicked: number; failed: number; cost: number }>; sessions: Array<{ k: string; n: number }> };
  insights: Array<{ severity: string; title: string; body: string; link: string; kind: string }>;
  freshness: Array<{ id: string; name: string; last_sync_at: string; freshness_minutes: number; mode: string }>;
};
type Filters = { providers: Array<{ id: string; name: string }>; channels: Array<{ key: string; name: string }>; segments: Array<{ id: string; name: string }>; campaigns: Array<{ id: string; name: string }> };

const F: Record<Metric["format"], (v: unknown) => string> = { int: fmt.int, pct: (v) => fmt.pct(v), money: fmt.money, ms: fmt.ms, float: (v) => (v == null ? "–" : Number(v).toLocaleString()) };
const DRILL: Record<string, string> = { total_users: "/audience?tab=explorer", kyc_rate: "/audience?tab=overview", launch_success: "/analytics?tab=gaming", avg_load: "/analytics?tab=gaming", delivery_rate: "/channels?tab=delivery", messages_sent: "/channels?tab=delivery", pending_approvals: "/compliance?tab=approvals", opps: "/opportunities", ai_running: "/opportunities", issued: "/offers?tab=transactions", budget_util: "/offers?tab=budgets", search_success: "/analytics?tab=gaming", campaigns_completed: "/campaigns", journey_completion: "/journeys", optimized: "/optimizer", reachable: "/compliance?tab=policies" };

export default function OverviewPage() {
  const { days, t, openCopilot } = useGlobal(); const router = useRouter();
  const [f, setF] = useState({ platform: "", provider: "", channel: "", segment: "", campaign: "" });
  const qs = useMemo(() => { const p = new URLSearchParams({ days: String(days) }); for (const [k, v] of Object.entries(f)) if (v) p.set(k, v); return p.toString(); }, [days, f]);
  const o = useApi<Overview>(`overview?${qs}`);
  const filters = useApi<Filters>("filters");
  const [metric, setMetric] = useState<Metric | null>(null);
  const [live, setLive] = useState(0);
  const tm = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connected = useStream("stream?topics=events,delivery,workflow,approvals,strategies,offers", () => { setLive((x) => x + 1); if (tm.current) clearTimeout(tm.current); tm.current = setTimeout(() => o.refresh(), 2500); });
  const d = o.data;
  const section = (title: string, ms: Metric[] | undefined) => (
    <div>
      <div className="text-[12px] font-semibold text-muted uppercase tracking-wide mb-2">{title}</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-5 gap-2">
        {(ms ?? Array.from({ length: 5 }).map((_, i) => ({ key: String(i), label: "", value: null, prev: null, format: "int" as const, definition: "", formula: "", source: "" }) as Metric)).map((m) =>
          <Stat key={m.key} label={m.label} value={m.value} prev={m.prev} format={F[m.format]} hint={m.definition} loading={o.loading && !d} invert={["avg_load", "gaming_error_rate", "channel_cost", "ai_cost", "offer_complaints"].includes(m.key)} onClick={d ? () => setMetric(m) : undefined} />)}
      </div>
    </div>
  );
  const exportAll = () => d && downloadCsv(`overview-${days}d`, [...d.customer, ...d.gaming, ...d.engagement, ...d.ai, ...d.offers].map((m) => ({ group: "", key: m.key, label: m.label, value: m.value, previous: m.prev, formula: m.formula, source: m.source })));
  return (
    <div className="space-y-5">
      <PageHeader title={t("overview")} subtitle={<span className="flex items-center gap-2">Executive & operational view · last {days === 1 ? "24 hours" : `${days} days`}<span className={cx("inline-flex items-center gap-1 text-[11px]", connected ? "text-ok" : "text-faint")}><Activity size={11} className={connected ? "pulse" : ""} />{connected ? `live · ${live} updates` : "connecting"}</span></span>}
        actions={<>
          <Select aria-label="Platform" value={f.platform} onChange={(e) => setF({ ...f, platform: e.target.value })} options={[{ value: "", label: t("all_platforms") }, "app", "h5", "pc"]} />
          <Select aria-label="Provider" value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })} options={[{ value: "", label: t("all_providers") }, ...(filters.data?.providers ?? []).map((p) => ({ value: p.id, label: p.name }))]} className="max-w-40" />
          <Select aria-label="Channel" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })} options={[{ value: "", label: t("all_channels") }, ...(filters.data?.channels ?? []).map((p) => ({ value: p.key, label: p.name }))]} />
          <Select aria-label="Segment" value={f.segment} onChange={(e) => setF({ ...f, segment: e.target.value })} options={[{ value: "", label: t("all_segments") }, ...(filters.data?.segments ?? []).map((p) => ({ value: p.id, label: p.name }))]} className="max-w-44" />
          <Select aria-label="Campaign" value={f.campaign} onChange={(e) => setF({ ...f, campaign: e.target.value })} options={[{ value: "", label: "All campaigns" }, ...(filters.data?.campaigns ?? []).map((p) => ({ value: p.id, label: p.name }))]} className="max-w-44" />
          <Button size="sm" variant="ghost" onClick={o.refresh} aria-label={t("refresh")}><RefreshCw size={13} /></Button>
          <Button size="sm" onClick={exportAll}><Download size={13} />{t("export")}</Button>
        </>} />
      <ErrorState error={o.error} onRetry={o.refresh} />

      <Card title={<span className="flex items-center gap-2"><Bot size={14} className="text-accent" />{t("insights")}</span>} actions={<Button size="sm" variant="subtle" onClick={() => openCopilot("Any anomalies this week? Summarize what needs attention.")}>Investigate with Copilot</Button>}>
        {!d ? <div className="grid md:grid-cols-3 gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div> :
          d.insights.length ? <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-2">{d.insights.map((x) => (
            <button key={x.title} onClick={() => router.push(x.link)} className="text-left rounded-md border border-border p-3 hover:border-border-strong">
              <div className="flex items-center gap-2"><AlertTriangle size={14} className={x.severity === "critical" ? "text-bad" : x.severity === "warning" ? "text-warn" : "text-info"} /><span className="text-[13px] font-medium flex-1">{x.title}</span><Provenance kind={x.kind} /></div>
              <div className="text-xs text-muted mt-1">{x.body}</div>
            </button>))}</div> : <div className="text-xs text-muted">No anomalies detected for the current filters.</div>}
      </Card>

      {section(t("customer_metrics"), d?.customer)}
      {section(t("gaming_metrics"), d?.gaming)}

      <div className="grid lg:grid-cols-3 gap-3">
        <Card title="Active players & launch success" className="lg:col-span-2" subtitle="Daily distinct active players vs. launch success rate">
          {d ? <Chart height={250} option={line(d.charts.daily.map((x) => x.d.slice(5)), [{ name: "Active players", data: d.charts.daily.map((x) => x.active), area: true }, { name: "Launch success %", data: d.charts.daily.map((x) => (x.ok + x.fail ? Math.round((x.ok / (x.ok + x.fail)) * 1000) / 10 : null)), yAxisIndex: 1 }], { dualAxis: true })} /> : <Skeleton className="h-[250px]" />}
        </Card>
        <Card title="Lifecycle distribution">{d ? <Chart height={250} option={pie(d.charts.lifecycle.map((x) => ({ name: x.k, value: x.n })))} onClick={(p) => router.push(`/audience?tab=explorer&lifecycle_stage=${p.name}`)} /> : <Skeleton className="h-[250px]" />}</Card>
      </div>
      <div className="grid lg:grid-cols-3 gap-3">
        <Card title="Provider launch failure rate" subtitle="Click a bar to filter the dashboard by provider" className="lg:col-span-2">
          {d ? <Chart height={260} option={bar(d.charts.providers.slice(0, 12).map((p) => p.name), [{ name: "Failure rate %", data: d.charts.providers.slice(0, 12).map((p) => Math.round((p.failures / p.launches) * 1000) / 10) }])} onClick={(p) => { const pr = d.charts.providers.find((x) => x.name === p.name); if (pr) setF({ ...f, provider: pr.id }); }} /> : <Skeleton className="h-[260px]" />}
        </Card>
        <Card title="Game session duration">{d ? <Chart height={260} option={bar(["<5m", "5–15m", "15–30m", "30–60m", "60m+"], [{ name: "Sessions", data: ["<5m", "5–15m", "15–30m", "30–60m", "60m+"].map((k) => d.charts.sessions.find((s) => s.k === k)?.n ?? 0) }])} /> : <Skeleton className="h-[260px]" />}</Card>
      </div>

      {section(t("engagement_metrics"), d?.engagement)}
      <div className="grid lg:grid-cols-2 gap-3">
        <Card title="Messages sent vs delivered">{d ? <Chart height={240} option={bar(d.charts.msgs.map((x) => x.d.slice(5)), [{ name: "Sent", data: d.charts.msgs.map((x) => x.sent) }, { name: "Delivered", data: d.charts.msgs.map((x) => x.delivered) }])} /> : <Skeleton className="h-[240px]" />}</Card>
        <Card title="Channel performance" pad={false}>
          <div className="p-3">{d ? <DataTable dense rows={d.charts.channels as unknown as Record<string, unknown>[]} onRow={(r) => router.push(`/channels?channel=${r.channel}`)} cols={[
            { key: "channel", label: "Channel", render: (r) => <span className="font-medium">{String(r.channel)}</span> }, { key: "total", label: "Sent", align: "right", render: (r) => fmt.int(r.total) },
            { key: "dr", label: "Delivery", align: "right", sort: (r) => Number(r.delivered) / Number(r.total), render: (r) => { const v = Number(r.delivered) / Number(r.total); return <span className={v < 0.9 ? "text-bad font-medium" : ""}>{fmt.pct(v)}</span>; } },
            { key: "rr", label: "Read", align: "right", render: (r) => fmt.pct(Number(r.read) / Math.max(1, Number(r.delivered))) }, { key: "cost", label: "Cost", align: "right", render: (r) => fmt.money(r.cost) },
          ]} /> : <Skeleton className="h-[200px]" />}</div>
        </Card>
      </div>
      {section(t("ai_metrics"), d?.ai)}
      {section(t("offer_metrics"), d?.offers)}

      <Card title="Data freshness" subtitle="All integrations run in mock mode until explicitly configured">
        <div className="flex flex-wrap gap-2">{(d?.freshness ?? []).map((s) => <div key={s.id} className="rounded-md border border-border px-2.5 py-1.5 text-xs"><div className="font-medium">{s.name}</div><div className="text-muted">{fmt.ago(s.last_sync_at)} · <Badge tone={s.mode === "live" ? "ok" : "info"}>{s.mode}</Badge></div></div>)}</div>
        {d && <div className="text-[11px] text-faint mt-2">Computed in {d.computed_ms} ms directly from the shared database.</div>}
      </Card>

      <Drawer open={!!metric} onClose={() => setMetric(null)} title={metric?.label} width={460}>
        {metric && <div className="space-y-4">
          <div className="text-[28px] font-semibold tabular-nums">{F[metric.format](metric.value)}</div>
          <KV items={[["Definition", metric.definition], ["Formula", <code key="f" className="font-mono text-xs">{metric.formula}</code>], ["Source", metric.source], ["Previous period", metric.prev == null ? "–" : F[metric.format](metric.prev)], ["Filters", qs]]} />
          {DRILL[metric.key] && <Button variant="primary" onClick={() => router.push(DRILL[metric.key])}>Drill down</Button>}
          <Button variant="subtle" onClick={() => openCopilot(`Explain the ${metric.label} metric for the last ${days} days and what drives it.`)}><Bot size={13} />Ask Copilot</Button>
        </div>}
      </Drawer>
    </div>
  );
}
