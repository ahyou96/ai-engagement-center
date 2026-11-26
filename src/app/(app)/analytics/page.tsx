"use client";
import { Suspense, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Bot, Download, RefreshCw } from "lucide-react";
import { useApi, useGlobal, fmt, downloadCsv } from "@/components/hooks";
import { Badge, Button, Card, DataTable, ErrorState, Loading, Notice, PageHeader, Stat, Tabs, Col } from "@/components/ui";
import { Chart, bar, line, pie } from "@/components/chart";
import type { EChartsOption } from "echarts";

type R = Record<string, unknown>;
const TABS = ["customers", "gaming", "campaigns", "journeys", "channels", "segments", "offers", "service", "cohorts", "attribution", "costs", "ai", "strategies", "compliance"] as const;
const LABELS: Record<string, string> = { customers: "Customers", gaming: "Gaming experience", campaigns: "Campaigns", journeys: "Journeys", channels: "Channels", segments: "Segments", offers: "Offers", service: "Customer service", cohorts: "Cohorts", attribution: "Attribution", costs: "Costs", ai: "AI performance", strategies: "Strategies", compliance: "Compliance" };
const PROMPTS: Record<string, string> = {
  customers: "Summarize customer analytics: lifecycle, registrations, KYC and reachability for the selected period.",
  gaming: "Summarize the gaming experience funnel, launch failures by error code and OS, and search no-result issues.",
  campaigns: "Summarize campaign performance. Be explicit about which results are correlational versus A/B causal evidence.",
  journeys: "Summarize journey execution performance: completions, exits and errors.",
  channels: "Compare channel delivery, read rates and cost this period.",
  segments: "Summarize segment sizes and membership churn in the last 7 days.",
  offers: "Summarize entitlement decisions, lifecycle, fairness by tier and budget utilization.",
  service: "Summarize customer service volume, categories and resolution times.",
  cohorts: "Summarize cohort retention trends by registration week.",
  attribution: "Explain campaign attribution results and their limitations (correlation vs causation).",
  costs: "Summarize channel, AI and entitlement costs.",
  ai: "Summarize AI workflow and agent performance: success, durations, confidence and cost.",
  strategies: "Summarize strategy version performance and experiment evidence.",
  compliance: "Summarize compliance blocks by policy, exclusions and approval outcomes.",
};
const n = (v: unknown) => Number(v ?? 0);
const rate = (a: unknown, b: unknown) => (n(b) ? n(a) / n(b) : null);

function Inner() {
  const sp = useSearchParams(); const router = useRouter();
  const { days, t, openCopilot } = useGlobal();
  const tab = (TABS as readonly string[]).includes(sp.get("tab") ?? "") ? String(sp.get("tab")) : "customers";
  const q = useApi<unknown>(`analytics/${tab}?days=${days}`, [tab]);
  const computedAt = useMemo(() => (q.data ? new Date() : null), [q.data]);
  return (
    <div className="space-y-4">
      <PageHeader title={t("analytics")} subtitle={`${LABELS[tab]} · last ${days === 1 ? "24 hours" : `${days} days`}`}
        actions={<><Button size="sm" variant="ghost" onClick={q.refresh} aria-label="Refresh"><RefreshCw size={13} /></Button><Button size="sm" variant="subtle" onClick={() => openCopilot(PROMPTS[tab] + ` Period: last ${days} days.`)}><Bot size={13} />AI summary</Button></>} />
      <Tabs tabs={TABS.map((k) => ({ key: k, label: LABELS[k] }))} value={tab} onChange={(k) => router.replace(`/analytics?tab=${k}`)} />
      <Notice tone="info">Correlation ≠ causation; incremental improvement is only claimed with experimental evidence (randomized A/B variants or strategy experiments with holdouts).</Notice>
      <ErrorState error={q.error} onRetry={q.refresh} />
      {q.loading && !q.data ? <Loading rows={6} /> : q.data ? <TabBody tab={tab} data={q.data} /> : null}
      {computedAt && <div className="text-[11px] text-faint">Computed from the shared database at {computedAt.toLocaleTimeString()} · synthetic data, mock delivery receipts.</div>}
    </div>
  );
}

function Exp({ name, rows }: { name: string; rows: R[] }) {
  return <Button size="sm" variant="ghost" onClick={() => downloadCsv(name, rows)}><Download size={13} />Export CSV</Button>;
}

function TabBody({ tab, data }: { tab: string; data: unknown }) {
  const d = data as R;
  switch (tab) {
    case "customers": {
      const metrics = (d.metrics as Array<{ key: string; label: string; value: number | null; prev?: number | null; format: string; definition: string }>) ?? [];
      const ch = d as { daily: R[]; lifecycle: R[] };
      return <div className="space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">{metrics.map((m) => <Stat key={m.key} label={m.label} value={m.value} prev={m.prev} hint={m.definition} format={m.format === "pct" ? (v) => fmt.pct(v) : fmt.int} />)}</div>
        <div className="grid lg:grid-cols-3 gap-3">
          <Card title="Daily active players" className="lg:col-span-2"><Chart height={240} option={line(ch.daily.map((x) => String(x.d).slice(5)), [{ name: "Active", data: ch.daily.map((x) => n(x.active)), area: true }])} /></Card>
          <Card title="Lifecycle"><Chart height={240} option={pie(ch.lifecycle.map((x) => ({ name: String(x.k), value: n(x.n) })))} /></Card>
        </div>
        <Card title="Cohort retention (weekly)" actions={<Exp name="metrics-customers" rows={metrics as unknown as R[]} />}><CohortHeatmap c={d.cohorts as Cohorts} /></Card>
      </div>;
    }
    case "gaming": {
      const g = d as { funnel: Array<{ step: string; players: number }>; byEntry: R[]; errors: R[]; byOs: R[]; categories: R[]; topGames: R[]; searches: R[] };
      return <div className="space-y-3">
        <div className="grid lg:grid-cols-2 gap-3">
          <Card title="Gaming experience funnel" subtitle="Distinct players per step"><Chart height={260} option={{ tooltip: { trigger: "item" }, series: [{ type: "funnel", sort: "none", left: "5%", width: "70%", label: { show: true, position: "right", formatter: "{b}: {c}" }, data: g.funnel.map((s) => ({ name: s.step.replace("game_", ""), value: s.players })) }] } as EChartsOption} />
            <div className="flex flex-wrap gap-2 text-xs text-muted">{g.funnel.slice(1).map((s, i) => <span key={s.step}>{s.step.replace("game_", "")}: {fmt.pct(rate(s.players, g.funnel[i].players))}</span>)}</div></Card>
          <Card title="Entry sources (clicks)"><Chart height={260} option={bar(g.byEntry.map((x) => String(x.k)), [{ name: "Clicks", data: g.byEntry.map((x) => n(x.clicks)) }])} /></Card>
        </div>
        <div className="grid lg:grid-cols-3 gap-3">
          <Card title="Launch failures by error code"><Chart height={220} option={bar(g.errors.map((x) => String(x.k)), [{ name: "Failures", data: g.errors.map((x) => n(x.n)) }], { horizontal: true })} /></Card>
          <Card title="By operating system" pad={false}><div className="p-3"><DataTable dense rows={g.byOs} cols={[{ key: "k", label: "OS" }, { key: "n", label: "Launches", align: "right", render: (r) => fmt.int(r.n) }, { key: "fr", label: "Failure", align: "right", render: (r) => fmt.pct(rate(r.fail, r.n)) }, { key: "load", label: "Avg load", align: "right", render: (r) => fmt.ms(r.load) }]} /></div></Card>
          <Card title="Sessions by category"><Chart height={220} option={pie(g.categories.map((x) => ({ name: String(x.k), value: n(x.sessions) })))} /></Card>
        </div>
        <div className="grid lg:grid-cols-2 gap-3">
          <Card title="Top games" actions={<Exp name="top-games" rows={g.topGames} />}><DataTable dense rows={g.topGames} cols={[{ key: "name", label: "Game" }, { key: "provider", label: "Provider" }, { key: "sessions", label: "Sessions", align: "right" }]} /></Card>
          <Card title="Search keywords" actions={<Exp name="search-keywords" rows={g.searches} />}><DataTable dense rows={g.searches} cols={[{ key: "k", label: "Keyword" }, { key: "n", label: "Searches", align: "right" }, { key: "none", label: "No result", align: "right" }, { key: "nr", label: "No-result rate", align: "right", sort: (r) => n(r.none) / Math.max(1, n(r.n)), render: (r) => { const v = rate(r.none, r.n); return <span className={n(v) > 0.3 ? "text-bad font-medium" : ""}>{fmt.pct(v)}</span>; } }]} /></Card>
        </div>
      </div>;
    }
    case "campaigns": {
      const c = d as { campaigns: R[]; attribution: Attr };
      return <div className="space-y-3">
        <Card title="Campaign performance" actions={<Exp name="campaigns" rows={c.campaigns} />}><DataTable search={(r) => String(r.name)} rows={c.campaigns} cols={[
          { key: "name", label: "Campaign", render: (r) => <span className="font-medium">{String(r.name)}</span> }, { key: "purpose", label: "Purpose", render: (r) => <Badge>{String(r.purpose)}</Badge> }, { key: "status", label: "Status", render: (r) => <Badge>{String(r.status)}</Badge> },
          { key: "sent", label: "Sent", align: "right", render: (r) => fmt.int(r.sent) }, { key: "dr", label: "Delivery", align: "right", sort: (r) => n(r.delivered) / Math.max(1, n(r.sent)), render: (r) => fmt.pct(rate(r.delivered, r.sent)) },
          { key: "rr", label: "Read", align: "right", render: (r) => fmt.pct(rate(r.read, r.delivered)) }, { key: "ctr", label: "CTR", align: "right", render: (r) => fmt.pct(rate(r.clicked, r.delivered)) }, { key: "cost", label: "Cost", align: "right", render: (r) => fmt.money(r.cost) }]} /></Card>
        <AttributionView a={c.attribution} />
      </div>;
    }
    case "attribution": return <AttributionView a={d as unknown as Attr} />;
    case "journeys": {
      const rows = data as R[];
      return <div className="space-y-3">
        <Card title="Executions by journey"><Chart height={260} option={bar(rows.map((r) => String(r.name)), [{ name: "Completed", data: rows.map((r) => n(r.completed)) }, { name: "Exited", data: rows.map((r) => n(r.exited)) }, { name: "Active", data: rows.map((r) => n(r.active)) }, { name: "Errors", data: rows.map((r) => n(r.errors)) }], { stack: true })} /></Card>
        <Card title="Journey table" actions={<Exp name="journeys" rows={rows} />}><DataTable rows={rows} rowKey={(r) => String(r.name)} cols={[{ key: "name", label: "Journey" }, { key: "status", label: "Status", render: (r) => <Badge>{String(r.status)}</Badge> }, { key: "execs", label: "Executions", align: "right" }, { key: "completed", label: "Completed", align: "right", render: (r) => fmt.int(r.completed) }, { key: "exited", label: "Exited", align: "right", render: (r) => fmt.int(r.exited) }, { key: "active", label: "Active", align: "right", render: (r) => fmt.int(r.active) }, { key: "errors", label: "Errors", align: "right", render: (r) => fmt.int(r.errors) }]} /></Card>
      </div>;
    }
    case "channels": {
      const c = d as { stats: R[]; daily: R[] };
      const days = [...new Set(c.daily.map((x) => String(x.d)))].sort(); const chans = [...new Set(c.daily.map((x) => String(x.channel)))];
      return <div className="space-y-3">
        <Card title="Daily delivery rate by channel (%)"><Chart height={260} option={line(days.map((x) => x.slice(5)), chans.map((ch) => ({ name: ch, data: days.map((dd) => { const r = c.daily.find((x) => x.d === dd && x.channel === ch); return r ? Math.round((n(r.delivered) / Math.max(1, n(r.n))) * 1000) / 10 : null; }) })))} /></Card>
        <Card title="Channel stats" actions={<Exp name="channels" rows={c.stats} />}><DataTable rows={c.stats} rowKey={(r) => String(r.channel)} cols={[{ key: "channel", label: "Channel" }, { key: "total", label: "Sent", align: "right", render: (r) => fmt.int(r.total) }, { key: "dr", label: "Delivery", align: "right", render: (r) => { const v = rate(r.delivered, r.total); return <span className={n(v) < 0.9 ? "text-bad font-medium" : ""}>{fmt.pct(v)}</span>; } }, { key: "rr", label: "Read", align: "right", render: (r) => fmt.pct(rate(r.read, r.delivered)) }, { key: "ctr", label: "CTR", align: "right", render: (r) => fmt.pct(rate(r.clicked, r.delivered)) }, { key: "failed", label: "Failed", align: "right", render: (r) => fmt.int(r.failed) }, { key: "cost", label: "Cost", align: "right", render: (r) => fmt.money(r.cost) }]} /></Card>
      </div>;
    }
    case "segments": {
      const rows = data as R[];
      return <div className="space-y-3">
        <Card title="Largest segments"><Chart height={260} option={bar(rows.slice(0, 12).map((r) => String(r.name)), [{ name: "Members", data: rows.slice(0, 12).map((r) => n(r.member_count)) }], { horizontal: true })} /></Card>
        <Card title="Segment membership (7-day churn)" actions={<Exp name="segments" rows={rows} />}><DataTable search={(r) => String(r.name)} rows={rows} cols={[{ key: "name", label: "Segment" }, { key: "purpose", label: "Purpose", render: (r) => <Badge>{String(r.purpose)}</Badge> }, { key: "segment_type", label: "Type" }, { key: "member_count", label: "Members", align: "right", render: (r) => fmt.int(r.member_count) }, { key: "entered_7d", label: "Entered 7d", align: "right" }, { key: "exited_7d", label: "Exited 7d", align: "right" }]} /></Card>
      </div>;
    }
    case "offers": {
      const o = d as { distribution: R[]; lifecycle: R[]; fairness: R[]; budgets: R[]; duplicates: { n: number } };
      const outcomes = ["none", "reduced", "standard", "enhanced"]; const tiers = [...new Set(o.fairness.map((x) => String(x.vip_tier)))];
      return <div className="space-y-3">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <Stat label="Decisions (non-simulated)" value={o.distribution.reduce((s, x) => s + n(x.n), 0)} format={fmt.int} />
          <Stat label="Transactions" value={o.lifecycle.reduce((s, x) => s + n(x.n), 0)} format={fmt.int} />
          <Stat label="Duplicates prevented" value={o.duplicates?.n} format={fmt.int} />
          <Stat label="Budget utilization" value={rate(o.budgets.reduce((s, b) => s + n(b.reserved) + n(b.spent), 0), o.budgets.reduce((s, b) => s + n(b.total), 0))} format={(v) => fmt.pct(v)} />
        </div>
        <div className="grid lg:grid-cols-2 gap-3">
          <Card title="Fairness: outcome by membership tier" subtitle="Decisions use tier/tenure/KYC/budget only — never deposits, losses or wagering"><Chart height={260} option={bar(tiers, outcomes.map((oc) => ({ name: oc, data: tiers.map((tr) => n(o.fairness.find((x) => x.vip_tier === tr && x.outcome === oc)?.n)) })), { stack: true })} /></Card>
          <Card title="Entitlement lifecycle" actions={<Exp name="offer-lifecycle" rows={o.lifecycle} />}><DataTable dense rows={o.lifecycle} rowKey={(r, i) => `${r.name}${r.status}${i}`} cols={[{ key: "name", label: "Offer" }, { key: "status", label: "Status", render: (r) => <Badge>{String(r.status)}</Badge> }, { key: "n", label: "Count", align: "right" }, { key: "amount", label: "Amount", align: "right", render: (r) => fmt.money(r.amount) }]} /></Card>
        </div>
        <Card title="Budgets"><DataTable dense rows={o.budgets} cols={[{ key: "name", label: "Budget" }, { key: "scope", label: "Scope" }, { key: "total", label: "Total", align: "right", render: (r) => fmt.money(r.total) }, { key: "reserved", label: "Reserved", align: "right", render: (r) => fmt.money(r.reserved) }, { key: "spent", label: "Spent", align: "right", render: (r) => fmt.money(r.spent) }, { key: "u", label: "Utilization", align: "right", render: (r) => fmt.pct(rate(n(r.reserved) + n(r.spent), r.total)) }]} /></Card>
      </div>;
    }
    case "service": {
      const s = d as { byCategory: R[]; daily: R[]; open: number };
      return <div className="space-y-3">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2"><Stat label="Open tickets (now)" value={s.open} format={fmt.int} /><Stat label="Tickets in period" value={s.byCategory.reduce((a, x) => a + n(x.n), 0)} format={fmt.int} /><Stat label="Resolved in period" value={s.byCategory.reduce((a, x) => a + n(x.resolved), 0)} format={fmt.int} /></div>
        <Card title="Tickets per day"><Chart height={220} option={bar(s.daily.map((x) => String(x.d).slice(5)), [{ name: "Tickets", data: s.daily.map((x) => n(x.n)) }])} /></Card>
        <Card title="By category" actions={<Exp name="cs-categories" rows={s.byCategory} />}><DataTable rows={s.byCategory} rowKey={(r) => String(r.k)} cols={[{ key: "k", label: "Category" }, { key: "n", label: "Tickets", align: "right" }, { key: "resolved", label: "Resolved", align: "right" }, { key: "rr", label: "Resolution", align: "right", render: (r) => fmt.pct(rate(r.resolved, r.n)) }, { key: "avg_hours", label: "Avg hours to resolve", align: "right", render: (r) => (r.avg_hours == null ? "–" : String(r.avg_hours)) }]} /></Card>
      </div>;
    }
    case "cohorts": return <Card title="Weekly retention by registration cohort" actions={<Exp name="cohorts" rows={(d as unknown as Cohorts).rows as unknown as R[]} />}><CohortHeatmap c={d as unknown as Cohorts} /></Card>;
    case "costs": {
      const c = d as { channels: R[]; ai: R[]; offers: R[] };
      return <div className="grid lg:grid-cols-2 gap-3">
        <Card title="Channel cost" actions={<Exp name="channel-costs" rows={c.channels} />} className="lg:col-span-2"><DataTable rows={c.channels} rowKey={(r) => String(r.channel)} cols={[{ key: "channel", label: "Channel" }, { key: "n", label: "Messages", align: "right", render: (r) => fmt.int(r.n) }, { key: "cost", label: "Total cost", align: "right", render: (r) => fmt.money(r.cost) }, { key: "cost_per_delivered", label: "Cost / delivered", align: "right", render: (r) => (r.cost_per_delivered == null ? "–" : `₱${r.cost_per_delivered}`) }]} /></Card>
        <Card title="AI cost per workflow (estimated)"><DataTable dense rows={c.ai} rowKey={(r) => String(r.name)} cols={[{ key: "name", label: "Workflow" }, { key: "runs", label: "Runs", align: "right" }, { key: "tokens", label: "Tokens", align: "right", render: (r) => fmt.int(r.tokens) }, { key: "cost", label: "Cost (USD est.)", align: "right", render: (r) => `$${n(r.cost).toFixed(4)}` }]} /></Card>
        <Card title="Entitlement amounts"><DataTable dense rows={c.offers} rowKey={(r) => String(r.name)} cols={[{ key: "name", label: "Offer" }, { key: "issued", label: "Issued", align: "right" }, { key: "amount", label: "Amount", align: "right", render: (r) => fmt.money(r.amount) }]} /></Card>
      </div>;
    }
    case "ai": {
      const a = d as { byWorkflow: R[]; byAgent: R[]; tools: R[] };
      return <div className="space-y-3">
        <Card title="By workflow" actions={<Exp name="ai-workflows" rows={a.byWorkflow} />}><DataTable rows={a.byWorkflow} rowKey={(r) => String(r.name)} cols={[{ key: "name", label: "Workflow" }, { key: "runs", label: "Runs", align: "right" }, { key: "completed", label: "Completed", align: "right" }, { key: "failed", label: "Failed", align: "right" }, { key: "waiting", label: "Waiting approval", align: "right" }, { key: "sr", label: "Success", align: "right", render: (r) => fmt.pct(rate(r.completed, r.runs)) }, { key: "avg_seconds", label: "Avg duration (s)", align: "right" }, { key: "cost", label: "Cost (est.)", align: "right", render: (r) => `$${n(r.cost).toFixed(4)}` }]} /></Card>
        <div className="grid lg:grid-cols-2 gap-3">
          <Card title="By agent"><DataTable dense rows={a.byAgent} rowKey={(r) => String(r.agent_key)} cols={[{ key: "agent_key", label: "Agent" }, { key: "n", label: "Executions", align: "right" }, { key: "ok", label: "OK", align: "right" }, { key: "failed", label: "Failed", align: "right" }, { key: "avg_ms", label: "Avg ms", align: "right", render: (r) => fmt.int(r.avg_ms) }, { key: "avg_conf", label: "Avg confidence", align: "right", render: (r) => (r.avg_conf == null ? "–" : String(r.avg_conf)) }, { key: "tokens", label: "Tokens", align: "right", render: (r) => fmt.int(r.tokens) }]} /></Card>
          <Card title="Tool calls"><Chart height={260} option={bar(a.tools.map((x) => String(x.tool)), [{ name: "Calls", data: a.tools.map((x) => n(x.n)) }, { name: "Failed", data: a.tools.map((x) => n(x.failed)) }], { horizontal: true })} /></Card>
        </div>
      </div>;
    }
    case "strategies": {
      const rows = data as R[];
      return <Card title="Strategy versions" subtitle="Baseline vs candidate from experiments; p-value from two-proportion z-test" actions={<Exp name="strategy-versions" rows={rows} />}>
        <DataTable search={(r) => `${r.name} ${r.change_summary}`} rows={rows} rowKey={(r) => `${r.category}${r.version}`} cols={[{ key: "name", label: "Strategy" }, { key: "version", label: "Version", render: (r) => `v${r.version}` }, { key: "status", label: "Status", render: (r) => <Badge>{String(r.status)}</Badge> }, { key: "change_summary", label: "Change", className: "max-w-[280px] truncate" },
          { key: "b", label: "Baseline", align: "right", render: (r) => fmt.pct((r.baseline_metrics as { rate?: number } | null)?.rate) }, { key: "c", label: "Candidate", align: "right", render: (r) => fmt.pct((r.candidate_metrics as { rate?: number } | null)?.rate) },
          { key: "p_value", label: "p-value", align: "right", render: (r) => (r.p_value == null ? "–" : <span className={n(r.p_value) <= 0.05 ? "text-ok font-medium" : "text-warn"}>{n(r.p_value).toFixed(4)}</span>) }, { key: "created_at", label: "Created", render: (r) => fmt.day(r.created_at) }]} />
      </Card>;
    }
    case "compliance": {
      const c = d as { byPolicy: Record<string, number>; checks: { n: number; blocked: number }; exclusions: R[]; approvals: R[] };
      const pol = Object.entries(c.byPolicy ?? {}).sort((a, b) => b[1] - a[1]);
      return <div className="space-y-3">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2"><Stat label="Compliance checks" value={c.checks?.n} format={fmt.int} /><Stat label="Checks with blocks" value={c.checks?.blocked} format={fmt.int} /><Stat label="Active exclusions" value={c.exclusions.reduce((a, x) => a + n(x.n), 0)} format={fmt.int} /><Stat label="Approvals (all time)" value={c.approvals.reduce((a, x) => a + n(x.n), 0)} format={fmt.int} /></div>
        <div className="grid lg:grid-cols-3 gap-3">
          <Card title="Players blocked by policy" className="lg:col-span-2" actions={<Exp name="compliance-blocks" rows={pol.map(([k, v]) => ({ policy: k, blocked: v }))} />}>{pol.length ? <Chart height={260} option={bar(pol.map((x) => x[0]), [{ name: "Blocked", data: pol.map((x) => x[1]) }], { horizontal: true })} /> : <div className="text-xs text-muted">No compliance checks in this period.</div>}</Card>
          <Card title="Approvals by status"><Chart height={260} option={pie(c.approvals.map((x) => ({ name: String(x.k), value: n(x.n) })))} /></Card>
        </div>
        <Card title="Active exclusions by type"><DataTable dense rows={c.exclusions} rowKey={(r) => String(r.k)} cols={[{ key: "k", label: "Type" }, { key: "n", label: "Players", align: "right" }]} /></Card>
      </div>;
    }
  }
  return null;
}

type Attr = { rows: R[]; ab: R[]; caveat: string };
function AttributionView({ a }: { a: Attr }) {
  const camps = [...new Set(a.ab.map((x) => String(x.campaign_id)))];
  return <div className="space-y-3">
    <Notice tone="warn"><b>Correlation, not causation.</b> {a.caveat}</Notice>
    <Card title="Last-touch activity after message (≤3 days)" subtitle="Correlational — players active after a message may have played anyway" actions={<Exp name="attribution" rows={a.rows} />}>
      <DataTable rows={a.rows} cols={[{ key: "name", label: "Campaign" }, { key: "purpose", label: "Purpose", render: (r) => <Badge>{String(r.purpose)}</Badge> }, { key: "reached", label: "Reached", align: "right", render: (r) => fmt.int(r.reached) }, { key: "active_after", label: "Active after", align: "right", render: (r) => fmt.int(r.active_after) }, { key: "rate", label: "Share active", align: "right", render: (r) => fmt.pct(rate(r.active_after, r.reached)) }, { key: "kind", label: "Evidence", render: () => <Badge tone="warn">correlation</Badge> }]} />
    </Card>
    <Card title="A/B variant comparison" subtitle="Randomized split — the only causal evidence in this view">
      {camps.length ? camps.map((cid) => { const v = a.ab.filter((x) => x.campaign_id === cid); return <div key={cid} className="mb-3"><div className="text-[12.5px] font-medium mb-1">{String(v[0].name)} <Badge tone="ok">randomized</Badge></div>
        <DataTable dense rows={v} rowKey={(r) => String(r.variant)} cols={[{ key: "variant", label: "Variant" }, { key: "n", label: "Sent", align: "right" }, { key: "rr", label: "Read rate", align: "right", render: (r) => fmt.pct(rate(r.reads, r.n)) }, { key: "ctr", label: "CTR", align: "right", render: (r) => fmt.pct(rate(r.clicks, r.n)) }]} /></div>; }) : <div className="text-xs text-muted">No A/B tests have run.</div>}
    </Card>
  </div>;
}

type Cohorts = { sizes: Array<{ cohort: string; n: number }>; rows: Array<{ cohort: string; wk: number; n: number }>; note: string };
function CohortHeatmap({ c }: { c: Cohorts }) {
  if (!c?.sizes?.length) return <div className="text-xs text-muted">No cohorts in range.</div>;
  const weeks = Array.from({ length: Math.min(9, Math.max(1, ...c.rows.map((r) => r.wk + 1))) }, (_, i) => i);
  const cols: Col<R>[] = [{ key: "cohort", label: "Cohort (YYYY-WW)" }, { key: "size", label: "Size", align: "right" }, ...weeks.map((w) => ({ key: `w${w}`, label: `W${w}`, align: "right" as const, render: (r: R) => { const v = r[`w${w}`] as number | null; if (v == null) return <span className="text-faint">–</span>; return <span className="inline-block min-w-12 rounded px-1.5 py-0.5 tabular-nums" style={{ background: `rgba(99,102,241,${0.08 + v * 0.8})`, color: v > 0.5 ? "#fff" : undefined }}>{(v * 100).toFixed(0)}%</span>; } }))];
  const rows: R[] = c.sizes.map((s) => ({ cohort: s.cohort, size: s.n, ...Object.fromEntries(weeks.map((w) => { const r = c.rows.find((x) => x.cohort === s.cohort && x.wk === w); return [`w${w}`, r ? r.n / Math.max(1, s.n) : null]; })) }));
  return <div><DataTable dense rows={rows} rowKey={(r) => String(r.cohort)} cols={cols} pageSize={20} /><div className="text-[11px] text-faint mt-1">{c.note}</div></div>;
}

export default function Page() { return <Suspense><Inner /></Suspense>; }
