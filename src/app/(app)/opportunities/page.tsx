"use client";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, type Node, type Edge, type NodeProps } from "@xyflow/react";
import { Play, Pause, Square, RotateCcw, History, GitCompare, FlaskConical, Clock, Zap, Hand, OctagonAlert, Wrench, CheckCircle2, XCircle, Loader2, CircleDashed, Ban } from "lucide-react";
import { api, can, fmt, useApi, useGlobal, useStream, StreamEvent } from "@/components/hooks";
import { Badge, Button, Card, Confirm, DataTable, Drawer, Empty, ErrorState, Field, JsonView, KV, Loading, Modal, Notice, PageHeader, Provenance, Select, Status, Tabs, Textarea, Toggle, cx } from "@/components/ui";

type WfDef = { scenario: string; id: string; name: string; description: string; strategy: string; active_strategy: number | null; nodes: Array<{ key: string; agent: string; after: string[]; applies?: boolean; note?: string }> };
type RunRow = { id: string; name: string; scenario: string; status: string; mode: string; simulation: number; trigger: string; strategy_version: number; current_node: string | null; tokens: number; cost: number; error: string | null; started_by: string; started_at: string; finished_at: string | null; replay_of: string | null; opportunity_id: string | null };
type Workflows = { workflows: WfDef[]; runs: RunRow[]; definitions: Array<{ key: string; name: string; description: string; tools: string[] }>; emergency_stop: boolean };
type NodeExec = { id: string; node_key: string; agent_key: string; status: string; attempt: number; summary: string | null; evidence: Array<{ label: string; value: unknown; source: string; kind?: string }>; error: string | null; confidence: number | null; tokens: number; cost: number; started_at: string | null; finished_at: string | null; duration_ms: number | null; output: unknown; input: unknown };
type RunDetail = { run: RunRow & { params: Record<string, unknown> }; workflow: { id: string; scenario: string; name: string; nodes: WfDef["nodes"] }; nodes: NodeExec[]; tools: Array<{ id: string; node_key: string; tool: string; args: string; result_summary: string; status: string; duration_ms: number; at: string }>; decisions: Array<{ id: string; status: string; proposal: string; risk: string; approval_id: string; policy_result: string }>; strategy: { name: string; category: string } | null };
type Opp = { id: string; title: string; description: string; category: string; detected_at: string; severity: string; evidence: unknown[]; affected_users: number; affected_systems: string[]; possible_causes: string[]; recommended_actions: string[]; estimated_impact: string | null; risk_class: string; status: string; workflow_id: string | null; run_id: string | null; strategy_version: number | null };

// layout: two-row pipeline incl. pseudo nodes Data Sources / Strategy Registry / Next Execution
const POS: Record<string, [number, number]> = {
  sources: [0, 120], data_intel: [190, 120], discovery: [380, 120], gaming_intel: [570, 30], customer_intel: [570, 210], root_cause: [760, 120], decision: [950, 120], audience: [1140, 120],
  offer_eligibility: [1140, 330], campaign: [950, 420], journey: [950, 520], compliance: [760, 470], approval: [570, 470], execution: [380, 470], analytics: [190, 470], optimizer: [0, 470], registry: [0, 650], next: [380, 650],
};
const LABEL: Record<string, string> = { data_intel: "Data Intelligence", discovery: "Opportunity Discovery", gaming_intel: "Gaming Intelligence", customer_intel: "Customer Intelligence", root_cause: "Root Cause Analysis", decision: "Decision", audience: "Audience Segmentation", offer_eligibility: "Offer Eligibility & Budget", campaign: "Campaign Planning", journey: "Journey Planning", compliance: "Compliance", approval: "Approval Gateway", execution: "Execution", analytics: "Analytics", optimizer: "Strategy Optimizer" };
const STATUS_COLOR: Record<string, string> = { completed: "var(--ok)", running: "var(--info)", failed: "var(--bad)", waiting: "var(--warn)", skipped: "var(--faint)", pending: "var(--border-strong)", cancelled: "var(--faint)" };
const ICON: Record<string, React.ReactNode> = { completed: <CheckCircle2 size={13} className="text-ok" />, running: <Loader2 size={13} className="text-info animate-spin" />, failed: <XCircle size={13} className="text-bad" />, waiting: <Hand size={13} className="text-warn" />, skipped: <Ban size={13} className="text-faint" />, pending: <CircleDashed size={13} className="text-faint" />, cancelled: <Ban size={13} className="text-faint" /> };

type AgentData = { label: string; status: string; summary?: string | null; duration?: number | null; tokens?: number; attempt?: number; confidence?: number | null; pseudo?: boolean; sub?: string };
function AgentNode({ data, selected }: NodeProps<Node<AgentData>>) {
  return (
    <div className={cx("w-[170px] rounded-lg border bg-panel px-2.5 py-2 text-left shadow-sm transition-shadow", selected && "ring-2 ring-[var(--ring)]", data.pseudo && "bg-panel-2 border-dashed")} style={{ borderColor: data.pseudo ? undefined : STATUS_COLOR[data.status] ?? "var(--border)" }}>
      <Handle type="target" position={Position.Left} className="!bg-border-strong !w-1.5 !h-1.5 !border-0" />
      <div className="flex items-center gap-1.5">{data.pseudo ? <Zap size={12} className="text-accent" /> : ICON[data.status]}<span className="text-[11.5px] font-semibold truncate">{data.label}</span></div>
      {data.sub && <div className="text-[10px] text-muted mt-0.5 truncate">{data.sub}</div>}
      {!data.pseudo && <div className="text-[10px] text-muted mt-0.5 line-clamp-2 leading-snug min-h-[26px]">{data.summary ?? data.status}</div>}
      {!data.pseudo && (data.duration != null || data.tokens) ? <div className="flex gap-2 text-[9.5px] text-faint mt-1 tabular-nums">{data.duration != null && <span>{(data.duration / 1000).toFixed(1)}s</span>}{!!data.tokens && <span>{data.tokens} tok</span>}{data.confidence != null && <span>conf {Math.round(data.confidence * 100)}%</span>}{(data.attempt ?? 1) > 1 && <span className="text-warn">retry {data.attempt! - 1}</span>}</div> : null}
      <Handle type="source" position={Position.Right} className="!bg-border-strong !w-1.5 !h-1.5 !border-0" />
    </div>
  );
}
const nodeTypes = { agent: AgentNode };

function Canvas({ detail, onSelect, selected }: { detail: RunDetail; onSelect: (k: string) => void; selected: string | null }) {
  const { nodes, edges } = useMemo(() => {
    const byKey = new Map(detail.nodes.map((n) => [n.node_key, n]));
    const ns: Node<AgentData>[] = detail.workflow.nodes.map((d) => { const n = byKey.get(d.key); return { id: d.key, type: "agent", position: { x: POS[d.key][0], y: POS[d.key][1] }, selected: selected === d.key, data: { label: LABEL[d.key] ?? d.key, status: n?.status ?? "pending", summary: n?.summary, duration: n?.duration_ms, tokens: n?.tokens, attempt: n?.attempt, confidence: n?.confidence } }; });
    ns.push({ id: "sources", type: "agent", position: { x: POS.sources[0], y: POS.sources[1] }, data: { label: "Data Sources", status: "completed", pseudo: true, sub: "events · BI · CRM · KYC · CS (mock)" } });
    ns.push({ id: "registry", type: "agent", position: { x: POS.registry[0], y: POS.registry[1] }, data: { label: "Strategy Registry", status: "completed", pseudo: true, sub: `${detail.strategy?.name ?? ""} v${detail.run.strategy_version}` } });
    ns.push({ id: "next", type: "agent", position: { x: POS.next[0], y: POS.next[1] }, data: { label: "Next Execution", status: "completed", pseudo: true, sub: "uses latest approved active version" } });
    const es: Edge[] = [{ id: "s-d", source: "sources", target: "data_intel" }, { id: "o-r", source: "optimizer", target: "registry" }, { id: "r-n", source: "registry", target: "next" }];
    for (const d of detail.workflow.nodes) for (const a of d.after) {
      const st = byKey.get(d.key)?.status;
      es.push({ id: `${a}-${d.key}`, source: a, target: d.key, animated: st === "running", style: { stroke: st === "skipped" ? "var(--border)" : st === "completed" ? "var(--ok)" : st === "running" ? "var(--info)" : "var(--border-strong)", strokeDasharray: st === "skipped" ? "4 4" : undefined } });
    }
    return { nodes: ns, edges: es };
  }, [detail, selected]);
  return (
    <div className="h-[600px] rounded-md border border-border bg-panel-2">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.08 }} minZoom={0.3} nodesDraggable={false} nodesConnectable={false} onNodeClick={(_, n) => { if (LABEL[n.id]) onSelect(n.id); }} proOptions={{ hideAttribution: true }}>
        <Background gap={20} color="var(--border)" /><Controls showInteractive={false} /><MiniMap pannable zoomable style={{ background: "var(--panel)" }} maskColor="rgba(0,0,0,0.25)" nodeColor={(n) => STATUS_COLOR[(n.data as AgentData).status] ?? "#999"} />
      </ReactFlow>
    </div>
  );
}

function RunPanel({ runId, me, onRun }: { runId: string; me: ReturnType<typeof useGlobal>["me"]; onRun: (id: string) => void }) {
  const { toast } = useGlobal();
  const d = useApi<RunDetail>(`workflows/runs/${runId}`);
  const [sel, setSel] = useState<string | null>(null);
  const [log, setLog] = useState<StreamEvent[]>([]);
  const [busy, setBusy] = useState("");
  const [modify, setModify] = useState<string | null>(null);
  useEffect(() => { setLog([]); setSel(null); }, [runId]);
  useStream(`workflows/runs/${runId}/stream`, (e) => { setLog((l) => [...l.slice(-300), e]); if (/node\.|run\./.test(e.type)) d.refresh(); });
  const control = async (action: string, node?: string) => {
    setBusy(action);
    try { const r = await api<{ run_id?: string }>(`workflows/runs/${runId}/control`, { body: { action, node } }); if (r.run_id) { toast({ kind: "success", title: "Replay started (simulation)" }); onRun(r.run_id); } else d.refresh(); }
    catch (e) { toast({ kind: "error", title: (e as Error).message }); } setBusy("");
  };
  if (d.error) return <ErrorState error={d.error} onRetry={d.refresh} />;
  if (!d.data?.nodes) return <Loading rows={8} />;
  const { run, nodes, tools, decisions } = d.data;
  const done = nodes.filter((n) => ["completed", "skipped"].includes(n.status)).length;
  const node = sel ? nodes.find((n) => n.node_key === sel) : null;
  const pendingDecision = decisions.find((x) => x.status === "pending");
  const ctl = can(me, "workflows.control");
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Status value={run.status} />{run.simulation ? <Badge tone="info"><FlaskConical size={11} />simulation</Badge> : <Badge tone="warn">live (mock sending)</Badge>}<Badge>{run.mode} mode</Badge>
        <Badge tone="accent" title="Strategy version pinned at run start">strategy v{run.strategy_version}</Badge><Badge>{run.trigger}</Badge>{run.replay_of && <Badge>replay of {run.replay_of.slice(-6)}</Badge>}
        <span className="text-xs text-muted">{fmt.int(run.tokens)} tokens · est. ${Number(run.cost).toFixed(4)} · {fmt.date(run.started_at)}</span>
        <div className="flex-1" />
        {ctl && run.status === "running" && <Button size="sm" onClick={() => control("pause")} loading={busy === "pause"}><Pause size={12} />Pause</Button>}
        {ctl && run.status === "paused" && <Button size="sm" onClick={() => control("resume")} loading={busy === "resume"}><Play size={12} />Resume</Button>}
        {ctl && ["running", "paused", "waiting_approval"].includes(run.status) && <Button size="sm" variant="ghost" onClick={() => control("stop")} loading={busy === "stop"}><Square size={12} />Stop</Button>}
        {ctl && <Button size="sm" variant="ghost" onClick={() => control("replay")} loading={busy === "replay"} title="Re-run as a simulation with the same pinned strategy version"><History size={12} />Historical replay</Button>}
      </div>
      <div className="h-1.5 rounded-full bg-panel-2 overflow-hidden"><div className="h-full bg-accent transition-all" style={{ width: `${(done / nodes.length) * 100}%` }} /></div>
      {run.error && <Notice tone={run.status === "failed" ? "bad" : "info"}>{run.error}</Notice>}
      {pendingDecision && (
        <Card title={<span className="flex items-center gap-2"><Hand size={14} className="text-warn" />Human decision required</span>} subtitle="The deterministic policy engine escalated these AI-proposed actions" actions={<>
          {can(me, "approvals.decide") && <Button size="sm" variant="ghost" onClick={() => setModify(pendingDecision.id)}>Modify actions</Button>}
          <Button size="sm" variant="primary" onClick={() => window.location.assign(`/compliance?tab=approvals&id=${pendingDecision.approval_id}`)}>Open approval</Button></>}>
          <DecisionView d={pendingDecision} />
        </Card>
      )}
      <div className="grid gap-3">
        <Canvas detail={d.data} onSelect={setSel} selected={sel} />
        <Card title="Live execution log" subtitle="Streamed over SSE (ordered, replayable, de-duplicated by event id)" pad={false}>
          <div className="h-[240px] overflow-y-auto scroll-thin p-2 space-y-1 font-mono text-[11px]">
            {log.map((e) => (
              <div key={e.seq} className="flex gap-2"><span className="text-faint shrink-0">{new Date(e.at).toLocaleTimeString()}</span>
                <span className={cx("shrink-0", /failed/.test(e.type) ? "text-bad" : /completed|finished/.test(e.type) ? "text-ok" : /waiting|retry/.test(e.type) ? "text-warn" : "text-info")}>{e.type}</span>
                <span className="text-muted break-all">{String(e.payload.node ?? "")} {String(e.payload.tool ?? "")} {String(e.payload.summary ?? e.payload.error ?? e.payload.reason ?? e.payload.status ?? "")}</span></div>))}
            {!log.length && <div className="text-faint p-2">Waiting for events…</div>}
          </div>
        </Card>
      </div>
      <Card title="Node executions" pad={false}><div className="p-3"><DataTable dense rows={nodes as unknown as Record<string, unknown>[]} onRow={(r) => setSel(String(r.node_key))} rowKey={(r) => String(r.id)} cols={[
        { key: "node_key", label: "Agent", render: (r) => <span className="font-medium">{LABEL[String(r.node_key)]}</span> }, { key: "status", label: "Status", render: (r) => <Status value={String(r.status)} /> },
        { key: "summary", label: "Output summary", className: "max-w-[520px]", render: (r) => <span className="line-clamp-2 text-muted">{String(r.summary ?? "–")}</span> },
        { key: "duration_ms", label: "Duration", align: "right", render: (r) => (r.duration_ms == null ? "–" : `${(Number(r.duration_ms) / 1000).toFixed(2)}s`) }, { key: "attempt", label: "Attempt", align: "right" }, { key: "tokens", label: "Tokens", align: "right", render: (r) => fmt.int(r.tokens) },
      ]} /></div></Card>
      <Drawer open={!!node} onClose={() => setSel(null)} title={node ? `${LABEL[node.node_key]} Agent` : ""} width={620} footer={node?.status === "failed" && ctl ? <Button variant="primary" onClick={() => control("retry", node.node_key)} loading={busy === "retry"}><RotateCcw size={13} />Retry failed node</Button> : undefined}>
        {node && <div className="space-y-4">
          <KV items={[["Status", <Status key="s" value={node.status} />], ["Attempt", node.attempt], ["Started", fmt.date(node.started_at)], ["Duration", node.duration_ms == null ? "–" : `${node.duration_ms} ms`], ["Tokens / est. cost", `${node.tokens} · $${Number(node.cost).toFixed(5)}`], ["Confidence / evidence quality", node.confidence == null ? "–" : `${Math.round(node.confidence * 100)}%`], ["Strategy version", `v${run.strategy_version}`]]} />
          {node.error && <Notice tone="bad">{node.error}</Notice>}
          <div><div className="text-xs font-semibold mb-1">Decision explanation / output summary</div><div className="text-[13px]">{node.summary ?? "–"}</div></div>
          {!!node.evidence?.length && <div><div className="text-xs font-semibold mb-1">Evidence & data references</div><div className="space-y-1">{node.evidence.map((e, i) => <div key={i} className="flex items-center gap-2 text-[12.5px] border border-border rounded-md px-2 py-1.5"><Provenance kind={e.kind ?? "verified"} /><span className="font-medium">{e.label}</span><span className="text-muted truncate flex-1">{typeof e.value === "object" ? JSON.stringify(e.value) : String(e.value)}</span><span className="text-[11px] text-faint">{e.source}</span></div>)}</div></div>}
          <div><div className="text-xs font-semibold mb-1">Tool execution log</div>{tools.filter((t) => t.node_key === node.node_key).map((t) => <div key={t.id} className="flex items-center gap-2 text-[12px] border-b border-border py-1.5"><Wrench size={12} className="text-faint" /><code className="font-mono">{t.tool}</code><Status value={t.status} /><span className="text-muted truncate flex-1" title={t.args}>{t.result_summary}</span><span className="text-faint tabular-nums">{t.duration_ms}ms</span></div>)}{!tools.some((t) => t.node_key === node.node_key) && <div className="text-xs text-faint">No tool calls</div>}</div>
          <div><div className="text-xs font-semibold mb-1">Structured input</div><JsonView value={node.input} /></div>
          <div><div className="text-xs font-semibold mb-1">Structured output</div><JsonView value={node.output} /></div>
          <div className="text-[11px] text-faint">Agents exchange structured JSON outputs. Private model reasoning is not shown; only observable tool calls, evidence and decision summaries.</div>
        </div>}
      </Drawer>
      <ModifyDecision id={modify} decision={decisions.find((x) => x.id === modify)} onClose={() => setModify(null)} onSaved={d.refresh} />
    </div>
  );
}

function DecisionView({ d }: { d: { proposal: string; risk: string; policy_result: string } }) {
  const actions = JSON.parse(d.proposal ?? "[]") as Array<{ type: string; risk: string; description?: string; audience?: number }>;
  const policy = (JSON.parse(d.policy_result ?? "{}") as { evaluations?: Array<{ type: string; auto: boolean; reasons: string[] }> }).evaluations ?? [];
  return <div className="space-y-1.5">{actions.map((a, i) => { const p = policy.find((x) => x.type === a.type); return (
    <div key={i} className="flex flex-wrap items-center gap-2 text-[12.5px] border border-border rounded-md px-2.5 py-1.5"><code className="font-mono text-xs">{a.type}</code><Status value={a.risk} /><span className="flex-1 text-muted">{a.description}{a.audience ? ` · ${fmt.int(a.audience)} players` : ""}</span>{p && <span className="text-[11px] text-faint">{p.auto ? "authorized for auto" : p.reasons.join("; ")}</span>}</div>); })}</div>;
}

function ModifyDecision({ id, decision, onClose, onSaved }: { id: string | null; decision?: { proposal: string }; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState(""); const { toast } = useGlobal();
  useEffect(() => { if (decision) setText(JSON.stringify(JSON.parse(decision.proposal), null, 2)); }, [decision]);
  return <Modal open={!!id} onClose={onClose} title="Human intervention: modify proposed actions" width={640} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => { try { await api(`workflows/decisions/${id}`, { body: { actions: JSON.parse(text) } }); toast({ kind: "success", title: "Proposal updated", body: "Approve it in the Approval Center to continue." }); onSaved(); onClose(); } catch (e) { toast({ kind: "error", title: (e as Error).message }); } }}>Save changes</Button></>}>
    <Notice className="mb-2">Edit or remove actions (JSON). Changes are audited; the approval is still required.</Notice>
    <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={14} className="w-full font-mono text-xs" />
  </Modal>;
}

function RunDialog({ open, onClose, workflows, initial, onStarted }: { open: boolean; onClose: () => void; workflows: WfDef[]; initial?: string; onStarted: (id: string) => void }) {
  const { toast, me } = useGlobal();
  const [s, setS] = useState({ scenario: initial ?? "provider_failure", mode: "manual", simulation: false, inject: "", schedule: 0 });
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (initial) setS((x) => ({ ...x, scenario: initial })); }, [initial]);
  const wf = workflows.find((w) => w.scenario === s.scenario);
  const start = async () => {
    setBusy(true);
    try {
      const r = await api<{ run_id?: string; scheduled?: boolean; due?: string }>("workflows/run", { body: { scenario: s.scenario, mode: s.mode, simulation: s.simulation, inject_failure: s.inject || undefined, schedule_minutes: s.schedule || undefined } });
      if (r.run_id) { onStarted(r.run_id); toast({ kind: "success", title: "Workflow started", body: wf?.name }); } else toast({ kind: "info", title: "Run scheduled", body: `Due ${fmt.date(r.due)}` });
      onClose();
    } catch (e) { toast({ kind: "error", title: (e as Error).message }); } setBusy(false);
  };
  return <Modal open={open} onClose={onClose} title="Run AI workflow" width={560} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={start} loading={busy}>{s.schedule ? <><Clock size={13} />Schedule</> : <><Play size={13} />Run now</>}</Button></>}>
    <div className="space-y-3">
      <Field label="Workflow"><Select value={s.scenario} onChange={(e) => setS({ ...s, scenario: e.target.value })} options={workflows.map((w) => ({ value: w.scenario, label: w.name }))} /></Field>
      {wf && <Notice>{wf.description}. Will use <b>{wf.strategy}</b> strategy <b>v{wf.active_strategy}</b> (latest approved & active).</Notice>}
      <Field label="Decision mode" hint={s.mode === "auto" ? "Only explicitly authorized, low-risk actions execute automatically; everything else escalates to approval." : "AI proposes; employees review, modify, approve or reject."}>
        <Select value={s.mode} onChange={(e) => setS({ ...s, mode: e.target.value })} options={[{ value: "manual", label: "Manual — human approves all actions" }, ...(can(me, "workflows.control") ? [{ value: "auto", label: "Automatic — policy-validated low-risk actions only" }] : [])]} />
      </Field>
      <div className="flex items-center justify-between"><div><div className="text-[13px] font-medium">Simulation</div><div className="text-xs text-muted">No messages, entitlements, segments or strategy changes are persisted</div></div><Toggle checked={s.simulation} onChange={(v) => setS({ ...s, simulation: v })} label="Simulation" /></div>
      <Field label="Inject transient failure (demo of retry / human intervention)"><Select value={s.inject} onChange={(e) => setS({ ...s, inject: e.target.value })} options={[{ value: "", label: "None" }, ...Object.entries(LABEL).map(([k, v]) => ({ value: k, label: v }))]} /></Field>
      <Field label="Schedule"><Select value={String(s.schedule)} onChange={(e) => setS({ ...s, schedule: Number(e.target.value) })} options={[{ value: "0", label: "Run now" }, { value: "1", label: "In 1 minute" }, { value: "5", label: "In 5 minutes" }, { value: "60", label: "In 1 hour" }]} /></Field>
    </div>
  </Modal>;
}

function CompareModal({ open, onClose, runs }: { open: boolean; onClose: () => void; runs: RunRow[] }) {
  const [a, setA] = useState(""); const [b, setB] = useState("");
  const cmp = useApi<{ diff: Array<{ node: string; a: { status: string; summary: string; duration: number }; b: { status: string; summary: string; duration: number } }>; a: RunDetail; b: RunDetail }>(a && b ? `workflows/compare?a=${a}&b=${b}` : null);
  const opts = runs.map((r) => ({ value: r.id, label: `${r.name} · v${r.strategy_version} · ${fmt.date(r.started_at)} · ${r.status}` }));
  return <Modal open={open} onClose={onClose} title="Compare runs" width={1000}>
    <div className="grid grid-cols-2 gap-2 mb-3"><Select value={a} onChange={(e) => setA(e.target.value)} options={[{ value: "", label: "Run A…" }, ...opts]} /><Select value={b} onChange={(e) => setB(e.target.value)} options={[{ value: "", label: "Run B…" }, ...opts]} /></div>
    {cmp.loading && <Loading />}
    {cmp.data && <table className="w-full text-[12px]"><thead className="text-muted"><tr><th className="text-left p-1.5">Agent</th><th className="text-left p-1.5">A (strategy v{cmp.data.a.run.strategy_version})</th><th className="text-left p-1.5">B (strategy v{cmp.data.b.run.strategy_version})</th></tr></thead>
      <tbody>{cmp.data.diff.map((x) => <tr key={x.node} className={cx("border-t border-border align-top", x.a.summary !== x.b.summary && "bg-accent-soft/30")}><td className="p-1.5 font-medium">{LABEL[x.node]}</td><td className="p-1.5"><Status value={x.a.status} /> <span className="text-muted">{x.a.summary}</span></td><td className="p-1.5"><Status value={x.b.status} /> <span className="text-muted">{x.b.summary}</span></td></tr>)}</tbody></table>}
    {!a || !b ? <div className="text-xs text-muted">Pick two runs (e.g. the same workflow before and after a strategy activation).</div> : null}
  </Modal>;
}

function Inner() {
  const sp = useSearchParams(); const router = useRouter(); const { t, me, toast } = useGlobal();
  const wf = useApi<Workflows>("workflows");
  const [tab, setTab] = useState(sp.get("tab") ?? "runs");
  const [runId, setRunId] = useState<string | null>(sp.get("run_id"));
  const [dialog, setDialog] = useState<string | null>(sp.get("run") ?? (sp.get("scenario") ? sp.get("scenario") : null));
  const [cmp, setCmp] = useState(false); const [estop, setEstop] = useState(false);
  const [oppF, setOppF] = useState({ status: "", severity: "" });
  const opps = useApi<Opp[]>(`opportunities?${new URLSearchParams(Object.entries(oppF).filter(([, v]) => v)).toString()}`);
  const [opp, setOpp] = useState<Opp | null>(null);
  useStream("stream?topics=workflow", (e) => { if (["run.started", "run.finished", "run.waiting_approval", "run.halted"].includes(e.type)) { wf.refresh(); opps.refresh(); } });
  useEffect(() => { if (!runId && wf.data?.runs.length) setRunId(wf.data.runs[0].id); }, [wf.data, runId]);
  useEffect(() => { const o = sp.get("opp"); if (o && opps.data) setOpp(opps.data.find((x) => x.id === o) ?? null); }, [sp, opps.data]);
  const pick = useCallback((id: string) => { setRunId(id); setTab("runs"); router.replace(`/opportunities?run_id=${id}`); }, [router]);
  const runs = wf.data?.runs ?? [];
  const stats = { running: runs.filter((r) => r.status === "running").length, waiting: runs.filter((r) => r.status === "waiting_approval").length, failed: runs.filter((r) => r.status === "failed").length, done: runs.filter((r) => r.status === "completed").length, open: (opps.data ?? []).filter((o) => ["new", "in_progress"].includes(o.status)).length };
  return (
    <div className="space-y-4">
      <PageHeader title={t("opportunities")} subtitle="Global AI operations command center — discovery, analysis, decisions, execution, feedback and optimization"
        actions={<>
          {can(me, "workflows.run") && <Button variant="primary" onClick={() => setDialog("provider_failure")}><Play size={13} />{t("run_now")}</Button>}
          <Button onClick={() => setCmp(true)}><GitCompare size={13} />Compare runs</Button>
          {can(me, "workflows.emergency_stop") && <Button variant={wf.data?.emergency_stop ? "danger" : "default"} onClick={() => setEstop(true)}><OctagonAlert size={13} />{wf.data?.emergency_stop ? "Emergency stop ON" : t("emergency_stop")}</Button>}
        </>} />
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {[["Open opportunities", stats.open], ["Running", stats.running], ["Waiting approval", stats.waiting], ["Failed", stats.failed], ["Completed", stats.done]].map(([l, v]) => <div key={String(l)} className="rounded-lg border border-border bg-panel px-3 py-2.5"><div className="text-[11.5px] text-muted">{l}</div><div className="text-[20px] font-semibold tabular-nums">{v as number}</div></div>)}
      </div>
      <Card pad={false}>
        <div className="px-3 pt-1"><Tabs value={tab} onChange={setTab} tabs={[{ key: "runs", label: "Live workflow" }, { key: "history", label: "Run history", count: runs.length }, { key: "opps", label: "Opportunities", count: opps.data?.length }, { key: "workflows", label: "Workflows & agents" }]} /></div>
        <div className="p-3">
          <ErrorState error={wf.error} onRetry={wf.refresh} />
          {tab === "runs" && (runId ? <>
            <div className="flex items-center gap-2 mb-3"><span className="text-xs text-muted">Run</span><Select value={runId} onChange={(e) => pick(e.target.value)} options={runs.map((r) => ({ value: r.id, label: `${r.name} · ${r.status} · v${r.strategy_version} · ${fmt.date(r.started_at)}${r.simulation ? " · sim" : ""}` }))} className="max-w-[560px]" /></div>
            <RunPanel runId={runId} me={me} onRun={pick} /></> : wf.loading ? <Loading /> : <Empty title="No runs yet" body="Start a workflow to see the multi-agent pipeline execute live." action={<Button variant="primary" onClick={() => setDialog("provider_failure")}>Run a workflow</Button>} />)}
          {tab === "history" && <DataTable rows={runs as unknown as Record<string, unknown>[]} onRow={(r) => pick(String(r.id))} exportName="workflow-runs" search={(r) => `${r.name} ${r.status} ${r.trigger}`} cols={[
            { key: "name", label: "Workflow", render: (r) => <span className="font-medium">{String(r.name)}</span> }, { key: "status", label: "Status", render: (r) => <Status value={String(r.status)} /> },
            { key: "mode", label: "Mode" }, { key: "simulation", label: "Sim", render: (r) => (r.simulation ? <Badge tone="info">sim</Badge> : "–") }, { key: "trigger", label: "Trigger" },
            { key: "strategy_version", label: "Strategy", render: (r) => `v${r.strategy_version}` }, { key: "tokens", label: "Tokens", align: "right", render: (r) => fmt.int(r.tokens) },
            { key: "started_at", label: "Started", render: (r) => fmt.date(r.started_at) }, { key: "started_by", label: "By" },
          ]} />}
          {tab === "opps" && <>
            <div className="flex gap-2 mb-2"><Select value={oppF.status} onChange={(e) => setOppF({ ...oppF, status: e.target.value })} options={[{ value: "", label: "All statuses" }, "new", "in_progress", "resolved", "dismissed"]} /><Select value={oppF.severity} onChange={(e) => setOppF({ ...oppF, severity: e.target.value })} options={[{ value: "", label: "All severities" }, "low", "medium", "high", "critical"]} /></div>
            <DataTable rows={(opps.data ?? []) as unknown as Record<string, unknown>[]} onRow={(r) => setOpp(r as unknown as Opp)} exportName="opportunities" search={(r) => `${r.title} ${r.category}`} cols={[
              { key: "id", label: "ID", render: (r) => <code className="text-[11px]">{String(r.id)}</code> }, { key: "title", label: "Opportunity", className: "max-w-[420px]", render: (r) => <span className="font-medium line-clamp-1">{String(r.title)}</span> },
              { key: "category", label: "Category" }, { key: "severity", label: "Severity", render: (r) => <Status value={String(r.severity)} /> }, { key: "affected_users", label: "Affected", align: "right", render: (r) => fmt.int(r.affected_users) },
              { key: "status", label: "Status", render: (r) => <Status value={String(r.status)} /> }, { key: "strategy_version", label: "Strategy", render: (r) => (r.strategy_version ? `v${r.strategy_version}` : "–") }, { key: "detected_at", label: "Detected", render: (r) => fmt.date(r.detected_at) },
            ]} /></>}
          {tab === "workflows" && <div className="space-y-3">
            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-2">{(wf.data?.workflows ?? []).map((w) => <div key={w.id} className="rounded-md border border-border p-3"><div className="flex items-center gap-2"><span className="font-medium text-[13px] flex-1">{w.name}</span><Badge tone="accent">v{w.active_strategy}</Badge></div><div className="text-xs text-muted mt-1">{w.description}</div><div className="text-[11px] text-faint mt-1">{w.nodes.filter((n) => n.applies !== false).length} active agents · {w.nodes.filter((n) => n.applies === false).length} not applicable</div>{can(me, "workflows.run") && <div className="flex gap-1.5 mt-2"><Button size="sm" variant="primary" onClick={() => setDialog(w.scenario)}><Play size={12} />Run</Button></div>}</div>)}</div>
            <DataTable dense rows={(wf.data?.definitions ?? []) as unknown as Record<string, unknown>[]} rowKey={(r) => String(r.key)} cols={[{ key: "name", label: "Agent", render: (r) => <span className="font-medium">{String(r.name)}</span> }, { key: "description", label: "Responsibility", render: (r) => <span className="text-muted">{String(r.description)}</span> }, { key: "tools", label: "Allowed tools", render: (r) => <div className="flex flex-wrap gap-1">{(r.tools as string[]).map((x) => <Badge key={x}>{x}</Badge>)}</div> }]} />
          </div>}
        </div>
      </Card>
      <RunDialog open={!!dialog} initial={dialog ?? undefined} onClose={() => { setDialog(null); if (sp.get("run")) router.replace("/opportunities"); }} workflows={wf.data?.workflows ?? []} onStarted={(id) => { wf.refresh(); pick(id); }} />
      <CompareModal open={cmp} onClose={() => setCmp(false)} runs={runs} />
      <Drawer open={!!opp} onClose={() => setOpp(null)} title={opp?.title} width={620} footer={opp && <>
        {can(me, "workflows.control") && opp.status !== "dismissed" && <Button onClick={async () => { await api(`opportunities/${opp.id}`, { body: { status: "dismissed" } }); toast({ kind: "info", title: "Opportunity dismissed" }); setOpp(null); opps.refresh(); }}>Dismiss</Button>}
        {opp.run_id && <Button onClick={() => { pick(opp.run_id!); setOpp(null); }}>View run</Button>}
        {can(me, "workflows.run") && opp.workflow_id && <Button variant="primary" onClick={() => { setDialog(Object.values(wf.data?.workflows ?? []).find((w) => w.id === opp.workflow_id)?.scenario ?? "provider_failure"); setOpp(null); }}><Play size={13} />Run workflow</Button>}</>}>
        {opp && <div className="space-y-4">
          <div className="flex flex-wrap gap-2"><Status value={opp.severity} /><Status value={opp.status} /><Badge>{opp.category}</Badge><Badge>risk {opp.risk_class}</Badge></div>
          <p className="text-[13px]">{opp.description}</p>
          <KV items={[["Opportunity ID", <code key="i">{opp.id}</code>], ["Detected", fmt.date(opp.detected_at)], ["Affected users", fmt.int(opp.affected_users)], ["Affected systems", opp.affected_systems.join(", ")], ["Estimated impact", opp.estimated_impact ?? "–"], ["Associated workflow", opp.workflow_id ?? "–"], ["Strategy version", opp.strategy_version ? `v${opp.strategy_version}` : "–"]]} />
          <div><div className="text-xs font-semibold mb-1">Possible causes</div><ul className="list-disc pl-5 text-[13px]">{opp.possible_causes.map((c) => <li key={c}>{c}</li>)}</ul></div>
          <div><div className="text-xs font-semibold mb-1">Recommended actions</div><ul className="list-disc pl-5 text-[13px]">{opp.recommended_actions.map((c) => <li key={c}>{c}</li>)}</ul></div>
          <div><div className="text-xs font-semibold mb-1">Supporting evidence</div><JsonView value={opp.evidence} /></div>
        </div>}
      </Drawer>
      <Confirm open={estop} onClose={() => setEstop(false)} danger={!wf.data?.emergency_stop} title={wf.data?.emergency_stop ? "Clear emergency stop?" : "Activate EMERGENCY STOP?"} confirmLabel={wf.data?.emergency_stop ? "Clear" : "Stop everything"}
        body={wf.data?.emergency_stop ? "Normal operation resumes; paused journeys/campaigns must be resumed individually." : "Stops all running workflows, pauses active journeys and approved campaigns. Protective/security/regulatory messages remain allowed."}
        onConfirm={async () => { try { await api("system/emergency-stop", { body: { on: !wf.data?.emergency_stop } }); wf.refresh(); } catch (e) { toast({ kind: "error", title: (e as Error).message }); } setEstop(false); }} />
    </div>
  );
}
export default function Page() { return <Suspense><Inner /></Suspense>; }
