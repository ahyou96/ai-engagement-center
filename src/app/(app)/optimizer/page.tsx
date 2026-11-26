"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, OctagonAlert, Plus, RefreshCw, Bot } from "lucide-react";
import { api, can, fmt, useApi, useGlobal, useStream, downloadCsv } from "@/components/hooks";
import { Badge, Button, Card, Confirm, DataTable, Drawer, ErrorState, Field, Input, JsonView, KV, Loading, Modal, Notice, PageHeader, Select, Stat, Status, Tabs, Textarea, Toggle, cx } from "@/components/ui";
import { Chart, bar } from "@/components/chart";

type R = Record<string, unknown>;
type StrategyRow = { id: string; name: string; category: string; objective: string; primary_metric: string; metric_direction: string; active_version: number | null; versions: number; pending: number };
type Settings = { auto_optimization: boolean; evaluation_frequency_hours: number; min_sample: number; min_improvement: number; confidence: number; max_deterioration: number; risk_threshold: string; approval_mode: string; auto_rollback: boolean; experiment_allocation: number };
type List = { strategies: StrategyRow[]; settings: Settings; next_evaluation: string; recent: Array<R & { name: string; verdict: string; version: number; at: string }> };
type Version = { id: string; version: number; parent_version: number | null; config: Record<string, unknown>; status: string; baseline_metrics: { rate?: number; n?: number } | null; candidate_metrics: { rate?: number; n?: number } | null; experiment_id: string | null; change_summary: string | null; risk_assessment: string | null; effective_at: string | null; rollback_version: number | null; approval_id: string | null; created_by: string; created_at: string };
type Detail = { strategy: StrategyRow & { created_at: string }; versions: Version[]; experiments: Array<R & { id: string; name: string; status: string; control_version: number; candidate_version: number; results: Array<{ variant: string; sample_size: number; successes: number; rate: number; ci_low: number | null; ci_high: number | null; p_value: number | null }> }>; evaluations: Array<{ id: string; version: number; verdict: string; notes: string; at: string; metrics: R }>; runs: Array<{ id: string; status: string; strategy_version: number; started_at: string }>; audit: Array<R & { seq: number; action: string; actor_id: string; at: string; details: string }> };

const LOOP = ["Strategy V1", "Execution", "Result collection", "Performance evaluation", "Problem identification", "Candidate generation", "Historical validation", "Controlled experiment", "Statistical evaluation", "Compliance validation", "Approval", "Registry update", "Next execution uses latest approved"];

function Inner() {
  const { t, me, toast } = useGlobal(); const sp = useSearchParams(); const router = useRouter();
  const tab = sp.get("tab") ?? "dashboard";
  const list = useApi<List>("strategies");
  const [selected, setSelected] = useState<string | null>(sp.get("strategy"));
  const [all, setAll] = useState<Array<Version & { strategy: string; strategy_id: string; category: string }>>([]);
  const [estop, setEstop] = useState(false);
  useStream("stream?topics=strategies", (e) => { list.refresh(); if (e.type === "strategy.activated" || e.type === "strategy.rolled_back") toast({ kind: "info", title: e.type.replace("strategy.", "Strategy "), body: `v${(e.payload as R).version ?? (e.payload as R).to}` }); });
  // registry: fetch all strategy details
  useEffect(() => {
    if (!list.data) return;
    Promise.all(list.data.strategies.map((s) => api<Detail>(`strategies/${s.id}`).then((d) => d.versions.map((v) => ({ ...v, strategy: s.name, strategy_id: s.id, category: s.category }))))).then((x) => setAll(x.flat())).catch(() => {});
  }, [list.data]);
  const k = useMemo(() => {
    const c = (st: string[]) => all.filter((v) => st.includes(v.status)).length;
    return { active: c(["active"]), candidates: c(["candidate", "testing", "pending_approval"]), approved: all.filter((v) => ["active", "archived", "approved"].includes(v.status) && v.created_by === "agent:optimizer").length, rejected: c(["rejected"]), rollbacks: c(["rolled_back"]), testing: c(["testing"]), pending: c(["pending_approval"]) };
  }, [all]);
  const canEstop = can(me, "workflows.emergency_stop");
  return (
    <div className="space-y-4">
      <PageHeader title={t("optimizer")} subtitle="Continuous learning loop over versioned strategies — every new execution uses the latest approved, active version"
        actions={<><Button size="sm" variant="ghost" onClick={list.refresh} aria-label="Refresh"><RefreshCw size={13} /></Button>{canEstop && <Button size="sm" variant="danger" onClick={() => setEstop(true)}><OctagonAlert size={13} />{t("emergency_stop")}</Button>}</>} />
      <Notice tone="info">This is versioned rules + controlled experiments, not automatic model retraining. The optimizer never optimizes gambling engagement, wagering intensity, losses, or incentives based on vulnerability.</Notice>
      <Tabs tabs={[{ key: "dashboard", label: "Strategy dashboard" }, { key: "registry", label: "Strategy Registry", count: all.length }, { key: "settings", label: "Optimization settings" }]} value={tab} onChange={(x) => router.replace(`/optimizer?tab=${x}`)} />
      <ErrorState error={list.error} onRetry={list.refresh} />
      {tab === "dashboard" && <>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
          <Stat label="Active strategies" value={k.active} format={fmt.int} loading={!all.length} />
          <Stat label="Candidates (all)" value={k.candidates} format={fmt.int} loading={!all.length} />
          <Stat label="Under testing" value={k.testing} format={fmt.int} loading={!all.length} />
          <Stat label="Pending approval" value={k.pending} format={fmt.int} loading={!all.length} onClick={() => router.push("/compliance?tab=approvals")} />
          <Stat label="Approved optimizations" value={k.approved} format={fmt.int} loading={!all.length} />
          <Stat label="Rejected" value={k.rejected} format={fmt.int} loading={!all.length} />
          <Stat label="Rollbacks" value={k.rollbacks} format={fmt.int} loading={!all.length} />
        </div>
        <Card title="Continuous optimization loop" subtitle={list.data ? `Next scheduled evaluation ${fmt.date(list.data.next_evaluation)} · every ${list.data.settings.evaluation_frequency_hours}h · approval mode: ${list.data.settings.approval_mode}` : undefined}>
          <div className="flex flex-wrap items-center gap-1">{LOOP.map((s, i) => <span key={s} className="flex items-center gap-1"><span className={cx("rounded-md border px-2 py-1 text-[11.5px]", i === LOOP.length - 1 ? "border-accent bg-accent-soft text-accent" : "border-border bg-panel-2")}>{i + 1}. {s}</span>{i < LOOP.length - 1 && <ChevronRight size={12} className="text-faint" />}</span>)}</div>
        </Card>
        <div className="grid lg:grid-cols-3 gap-3">
          <Card title="Strategies" className="lg:col-span-2" pad={false}><div className="p-3">{!list.data ? <Loading /> : <DataTable rows={list.data.strategies as unknown as R[]} onRow={(r) => setSelected(String(r.id))} cols={[
            { key: "name", label: "Strategy", render: (r) => <div><div className="font-medium">{String(r.name)}</div><div className="text-[11px] text-muted">{String(r.objective)}</div></div> },
            { key: "category", label: "Category", render: (r) => <code className="text-[11px]">{String(r.category)}</code> },
            { key: "active_version", label: "Active", render: (r) => <Badge tone="ok">v{String(r.active_version)}</Badge> },
            { key: "primary_metric", label: "Objective metric", render: (r) => <span className="text-xs">{String(r.primary_metric)} {r.metric_direction === "down" ? "↓" : "↑"}</span> },
            { key: "versions", label: "Versions", align: "right" }, { key: "pending", label: "Pending", align: "right", render: (r) => Number(r.pending) ? <Badge tone="warn">{String(r.pending)}</Badge> : "0" }]} />}</div></Card>
          <Card title="Recent evaluations" pad={false}><div className="divide-y divide-border max-h-[380px] overflow-y-auto scroll-thin">{(list.data?.recent ?? []).map((e) => <div key={String(e.id)} className="px-3 py-2 text-xs"><div className="flex items-center gap-2"><span className="font-medium truncate flex-1">{e.name} v{e.version}</span><Status value={e.verdict === "promote" ? "approved" : e.verdict === "observed" ? "completed" : e.verdict === "deterioration" ? "rejected" : "pending"} /></div><div className="text-muted mt-0.5">{e.verdict.replace(/_/g, " ")} · {fmt.ago(e.at)}</div></div>)}</div></Card>
        </div>
        <Card title="Optimization recommendations" subtitle="Generated by the Strategy Optimizer Agent at the end of each workflow run">
          <div className="space-y-1.5">{all.filter((v) => ["candidate", "testing", "pending_approval"].includes(v.status)).map((v) => <button key={v.id} onClick={() => setSelected(v.strategy_id)} className="w-full text-left flex items-center gap-2 rounded-md border border-border px-3 py-2 hover:border-border-strong"><Status value={v.status} /><span className="font-medium text-[12.5px]">{v.strategy} v{v.version}</span><span className="text-xs text-muted truncate flex-1">{v.change_summary}</span><Badge tone={v.risk_assessment === "low" ? "ok" : "warn"}>risk {v.risk_assessment}</Badge></button>)}
            {!all.some((v) => ["candidate", "testing", "pending_approval"].includes(v.status)) && <div className="text-xs text-muted">No open candidates. Run a workflow in Opportunity Finder — its optimizer step evaluates results and may propose a new version.</div>}</div>
        </Card>
      </>}
      {tab === "registry" && <Card title="Strategy Registry" actions={<Button size="sm" variant="ghost" onClick={() => downloadCsv("strategy-registry", all.map((v) => ({ id: v.id, strategy: v.strategy, category: v.category, version: v.version, parent: v.parent_version, status: v.status, effective_at: v.effective_at, rollback_version: v.rollback_version, change: v.change_summary, risk: v.risk_assessment, created_by: v.created_by })))}>Export CSV</Button>}>
        <DataTable search={(r) => `${r.strategy} ${r.change_summary} ${r.status}`} rows={all as unknown as R[]} onRow={(r) => setSelected(String(r.strategy_id))} cols={[
          { key: "id", label: "Strategy ID", render: (r) => <code className="text-[11px]">{String(r.id)}</code> }, { key: "strategy", label: "Name" }, { key: "category", label: "Category" },
          { key: "version", label: "Version", render: (r) => `v${r.version}` }, { key: "parent_version", label: "Parent", render: (r) => (r.parent_version == null ? "–" : `v${r.parent_version}`) }, { key: "status", label: "Status", render: (r) => <Status value={String(r.status)} /> },
          { key: "effective_at", label: "Effective", render: (r) => fmt.day(r.effective_at) }, { key: "rollback_version", label: "Rollback to", render: (r) => (r.rollback_version == null ? "–" : `v${r.rollback_version}`) },
          { key: "change_summary", label: "Change summary", className: "max-w-[300px] truncate" }, { key: "risk_assessment", label: "Risk", render: (r) => <Status value={String(r.risk_assessment)} /> }, { key: "created_by", label: "Created by" }]} />
      </Card>}
      {tab === "settings" && list.data && <SettingsForm initial={list.data.settings} onSaved={list.refresh} />}
      <StrategyDrawer id={selected} onClose={() => setSelected(null)} onChanged={list.refresh} />
      <Confirm open={estop} onClose={() => setEstop(false)} danger title="Activate EMERGENCY STOP?" confirmLabel="Activate emergency stop" body="All running AI workflows stop; active journeys and approved campaigns pause; only simulations may run. Protective, security and regulatory messages remain allowed. Audited."
        onConfirm={async () => { try { await api("system/emergency-stop", { body: { on: true } }); toast({ kind: "warning", title: "Emergency stop activated" }); } catch (e) { toast({ kind: "error", title: (e as Error).message }); } setEstop(false); }} />
    </div>
  );
}

function SettingsForm({ initial, onSaved }: { initial: Settings; onSaved: () => void }) {
  const { me, toast } = useGlobal(); const [s, setS] = useState(initial); const [busy, setBusy] = useState(false);
  const allowed = can(me, "strategies.activate");
  const num = (k: keyof Settings, step = 1) => <Input type="number" step={step} value={String(s[k])} disabled={!allowed} onChange={(e) => setS({ ...s, [k]: Number(e.target.value) })} />;
  const save = async () => { setBusy(true); try { await api("optimizer/settings", { method: "PUT", body: s }); toast({ kind: "success", title: "Optimization settings saved" }); onSaved(); } catch (e) { toast({ kind: "error", title: "Save failed", body: (e as Error).message }); } setBusy(false); };
  return <Card title="Optimization settings" subtitle={allowed ? "Changes are audited" : "Read-only — requires strategies.activate"} actions={<Button variant="primary" size="sm" onClick={save} loading={busy} disabled={!allowed}>Save</Button>}>
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
      <Field label="Automatic optimization"><Toggle checked={s.auto_optimization} disabled={!allowed} onChange={(v) => setS({ ...s, auto_optimization: v })} label="Automatic optimization" /></Field>
      <Field label="Evaluation frequency (hours)">{num("evaluation_frequency_hours")}</Field>
      <Field label="Minimum sample per arm" hint="Below this the verdict is 'insufficient evidence'">{num("min_sample")}</Field>
      <Field label="Minimum meaningful improvement" hint="Absolute rate difference, e.g. 0.02 = 2 pts">{num("min_improvement", 0.005)}</Field>
      <Field label="Statistical confidence" hint="e.g. 0.95 → p ≤ 0.05">{num("confidence", 0.01)}</Field>
      <Field label="Maximum allowable deterioration">{num("max_deterioration", 0.005)}</Field>
      <Field label="Risk threshold"><Select value={s.risk_threshold} disabled={!allowed} onChange={(e) => setS({ ...s, risk_threshold: e.target.value })} options={["low", "medium", "high"]} /></Field>
      <Field label="Approval mode" hint="Authorized automatic approval applies to low-risk, significant improvements only"><Select value={s.approval_mode} disabled={!allowed} onChange={(e) => setS({ ...s, approval_mode: e.target.value })} options={[{ value: "manual", label: "Manual approval" }, { value: "auto", label: "Authorized automatic approval (low risk)" }]} /></Field>
      <Field label="Automatic rollback"><Toggle checked={s.auto_rollback} disabled={!allowed} onChange={(v) => setS({ ...s, auto_rollback: v })} label="Automatic rollback" /></Field>
      <Field label="Experiment allocation" hint="Share of traffic for candidate (0.01–0.5)">{num("experiment_allocation", 0.01)}</Field>
    </div>
  </Card>;
}

function StrategyDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const d = useApi<Detail>(id ? `strategies/${id}` : null, [id]);
  const { me, toast, openCopilot } = useGlobal();
  const [confirm, setConfirm] = useState<{ action: string; version?: number; title: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false); const [cand, setCand] = useState(false); const [tab, setTab] = useState("versions");
  const [candCfg, setCandCfg] = useState(""); const [candSum, setCandSum] = useState("");
  useStream(id ? "stream?topics=strategies" : null, (e) => { if ((e.payload as R).strategy_id === id) d.refresh(); });
  const active = d.data?.versions.find((v) => v.status === "active");
  const act = async (action: string, version?: number, extra: R = {}) => {
    setBusy(true);
    try { const r = await api<R>(`strategies/${id}/action`, { body: { action, version, ...extra } }); toast({ kind: "success", title: `Strategy ${action}`, body: r.approvalId ? `Sent for approval ${r.approvalId}` : r.autoApproved ? "Auto-approved and activated" : undefined }); d.refresh(); onChanged(); }
    catch (e) { toast({ kind: "error", title: `${action} failed`, body: (e as Error).message }); }
    setBusy(false); setConfirm(null);
  };
  const canActivate = can(me, "strategies.activate"), canWrite = can(me, "strategies.write");
  return <Drawer open={!!id} onClose={onClose} width={860} title={d.data ? `${d.data.strategy.name}` : "Strategy"}>
    {!d.data ? <Loading rows={6} /> : <div className="space-y-4">
      <KV items={[["Category", <code key="c">{d.data.strategy.category}</code>], ["Objective", d.data.strategy.objective], ["Primary metric", `${d.data.strategy.primary_metric} (${d.data.strategy.metric_direction === "down" ? "lower is better" : "higher is better"})`], ["Active version", <Badge key="a" tone="ok">v{d.data.strategy.active_version}</Badge>]]} />
      <div className="flex flex-wrap gap-2">
        {canActivate && active?.rollback_version != null && <Button size="sm" variant="danger" onClick={() => setConfirm({ action: "rollback", title: `Roll back to v${active.rollback_version}?`, body: `v${active.version} will be marked rolled back and v${active.rollback_version} becomes active. Running executions stay pinned to their version; new executions use v${active.rollback_version}.` })}>Rollback to v{active.rollback_version}</Button>}
        {canWrite && <Button size="sm" onClick={() => { setCandCfg(JSON.stringify(active?.config ?? {}, null, 2)); setCandSum(""); setCand(true); }}><Plus size={13} />New candidate</Button>}
        <Button size="sm" variant="subtle" onClick={() => openCopilot(`Show the strategy history for ${d.data!.strategy.category} and explain the experiment evidence.`)}><Bot size={13} />Ask Copilot</Button>
      </div>
      <Card title="Performance by version" subtitle="Candidate rate from experiments (or evaluation) per version">
        <Chart height={200} option={bar([...d.data.versions].reverse().map((v) => `v${v.version}`), [{ name: "Baseline", data: [...d.data.versions].reverse().map((v) => Math.round((v.baseline_metrics?.rate ?? 0) * 1000) / 10) }, { name: "Candidate", data: [...d.data.versions].reverse().map((v) => Math.round((v.candidate_metrics?.rate ?? 0) * 1000) / 10) }])} />
      </Card>
      <Tabs tabs={[{ key: "versions", label: "Versions", count: d.data.versions.length }, { key: "experiments", label: "Experiments", count: d.data.experiments.length }, { key: "evaluations", label: "Evaluations", count: d.data.evaluations.length }, { key: "runs", label: "Executions", count: d.data.runs.length }, { key: "audit", label: "Audit", count: d.data.audit.length }]} value={tab} onChange={setTab} />
      {tab === "versions" && <div className="space-y-2">{d.data.versions.map((v) => (
        <div key={v.id} className={cx("rounded-md border p-3", v.status === "active" ? "border-ok/50" : "border-border")}>
          <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">v{v.version}</span><Status value={v.status} />{v.parent_version != null && <span className="text-xs text-muted">parent v{v.parent_version}</span>}{v.rollback_version != null && <span className="text-xs text-muted">rollback → v{v.rollback_version}</span>}<Badge tone={v.risk_assessment === "low" ? "ok" : "warn"}>risk {v.risk_assessment ?? "–"}</Badge><span className="text-xs text-faint ml-auto">{v.created_by} · {fmt.day(v.created_at)}{v.effective_at ? ` · effective ${fmt.day(v.effective_at)}` : ""}</span></div>
          <div className="text-[12.5px] mt-1">{v.change_summary}</div>
          {(v.baseline_metrics || v.candidate_metrics) && <div className="text-xs text-muted mt-1">Baseline {fmt.pct(v.baseline_metrics?.rate)} (n={v.baseline_metrics?.n ?? "–"}) → candidate {fmt.pct(v.candidate_metrics?.rate)} (n={v.candidate_metrics?.n ?? "–"})</div>}
          {active && v.id !== active.id && <ConfigDiff a={active.config} b={v.config} />}
          <div className="flex flex-wrap gap-1.5 mt-2">
            {canActivate && ["approved", "paused", "archived", "rolled_back"].includes(v.status) && <Button size="sm" variant="primary" disabled={busy} onClick={() => setConfirm({ action: "activate", version: v.version, title: `Activate v${v.version}?`, body: "New executions will use this version immediately. Running executions remain pinned to their version." })}>Activate</Button>}
            {canWrite && ["candidate", "testing", "pending_approval"].includes(v.status) && <Button size="sm" disabled={busy} onClick={() => act("submit", v.version)}>Submit for approval</Button>}
            {canWrite && ["active", "approved"].includes(v.status) && v.status !== "active" && <Button size="sm" variant="ghost" onClick={() => act("pause", v.version)}>Pause</Button>}
            {canWrite && !["active", "archived"].includes(v.status) && <Button size="sm" variant="ghost" onClick={() => act("archive", v.version)}>Archive</Button>}
            {v.approval_id && <a className="text-xs text-accent self-center" href={`/compliance?tab=approvals&id=${v.approval_id}`}>View approval</a>}
          </div>
          <details className="mt-2"><summary className="text-xs text-muted cursor-pointer">Configuration</summary><JsonView value={v.config} /></details>
        </div>))}</div>}
      {tab === "experiments" && <div className="space-y-2">{d.data.experiments.map((e) => { const c = e.results.find((r) => r.variant === "control"), k = e.results.find((r) => r.variant === "candidate"); return (
        <div key={e.id} className="rounded-md border border-border p-3 text-[12.5px]"><div className="flex items-center gap-2"><span className="font-medium">{e.name}</span><Status value={e.status} />{k?.p_value != null && <Badge tone={k.p_value <= 0.05 ? "ok" : "warn"}>p = {k.p_value.toFixed(4)}</Badge>}</div>
          <table className="w-full text-xs mt-2"><thead className="text-muted"><tr><th className="text-left">Variant</th><th className="text-right">n</th><th className="text-right">Successes</th><th className="text-right">Rate</th><th className="text-right">95% CI of diff</th></tr></thead>
            <tbody>{[c, k].filter(Boolean).map((r) => <tr key={r!.variant} className="border-t border-border"><td className="py-1">{r!.variant} (v{r!.variant === "control" ? e.control_version : e.candidate_version})</td><td className="text-right">{fmt.int(r!.sample_size)}</td><td className="text-right">{fmt.int(r!.successes)}</td><td className="text-right">{fmt.pct(r!.rate)}</td><td className="text-right">{r!.ci_low != null ? `${(r!.ci_low * 100).toFixed(1)} … ${(r!.ci_high! * 100).toFixed(1)} pts` : "–"}</td></tr>)}</tbody></table></div>); })}
        {!d.data.experiments.length && <div className="text-xs text-muted">No experiments yet.</div>}</div>}
      {tab === "evaluations" && <DataTable dense rows={d.data.evaluations as unknown as R[]} cols={[{ key: "at", label: "When", render: (r) => fmt.date(r.at) }, { key: "version", label: "Version", render: (r) => `v${r.version}` }, { key: "verdict", label: "Verdict", render: (r) => <Badge>{String(r.verdict)}</Badge> }, { key: "notes", label: "Notes" }, { key: "m", label: "Metrics", render: (r) => <code className="text-[10.5px]">{JSON.stringify(r.metrics).slice(0, 80)}</code> }]} />}
      {tab === "runs" && <DataTable dense rows={d.data.runs as unknown as R[]} cols={[{ key: "id", label: "Run", render: (r) => <a className="text-accent" href={`/opportunities?run=${r.id}`}>{String(r.id)}</a> }, { key: "strategy_version", label: "Pinned version", render: (r) => <Badge tone="accent">v{String(r.strategy_version)}</Badge> }, { key: "status", label: "Status", render: (r) => <Status value={String(r.status)} /> }, { key: "started_at", label: "Started", render: (r) => fmt.date(r.started_at) }]} />}
      {tab === "audit" && <DataTable dense rows={d.data.audit as unknown as R[]} rowKey={(r) => String(r.seq)} cols={[{ key: "at", label: "When", render: (r) => fmt.date(r.at) }, { key: "actor_id", label: "Actor" }, { key: "action", label: "Action" }, { key: "details", label: "Details", render: (r) => <code className="text-[10.5px]">{String(r.details).slice(0, 100)}</code> }]} />}
    </div>}
    <Confirm open={!!confirm} onClose={() => setConfirm(null)} title={confirm?.title ?? ""} body={confirm?.body} danger={confirm?.action === "rollback"} loading={busy} confirmLabel={confirm?.action === "rollback" ? "Roll back" : "Activate"} onConfirm={() => confirm && act(confirm.action, confirm.version)} />
    <Modal open={cand} onClose={() => setCand(false)} width={620} title="New candidate version" footer={<><Button onClick={() => setCand(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => { let cfg: unknown; try { cfg = JSON.parse(candCfg); } catch { toast({ kind: "error", title: "Invalid JSON" }); return; } await act("candidate", undefined, { config: cfg, summary: candSum || "Manual candidate" }); setCand(false); }}>Create candidate</Button></>}>
      <div className="space-y-3"><Notice tone="info">Candidates must pass historical validation / experiment, compliance and approval before activation.</Notice>
        <Field label="Change summary"><Input value={candSum} onChange={(e) => setCandSum(e.target.value)} placeholder="e.g. Shorten reminder wait to 36h" /></Field>
        <Field label="Configuration (JSON)"><Textarea rows={14} className="font-mono text-[12px]" value={candCfg} onChange={(e) => setCandCfg(e.target.value)} /></Field></div>
    </Modal>
  </Drawer>;
}
function ConfigDiff({ a, b }: { a: Record<string, unknown>; b: Record<string, unknown> }) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  if (!keys.length) return <div className="text-[11px] text-faint mt-1">Config identical to active</div>;
  return <table className="w-full text-[11.5px] mt-2 border border-border rounded"><thead className="bg-panel-2 text-muted"><tr><th className="text-left px-2 py-1">Key</th><th className="text-left px-2">Active</th><th className="text-left px-2">This version</th></tr></thead>
    <tbody>{keys.map((k) => <tr key={k} className="border-t border-border"><td className="px-2 py-1 font-mono">{k}</td><td className="px-2 font-mono text-bad">{JSON.stringify(a[k])}</td><td className="px-2 font-mono text-ok">{JSON.stringify(b[k])}</td></tr>)}</tbody></table>;
}

export default function Page() { return <Suspense><Inner /></Suspense>; }
