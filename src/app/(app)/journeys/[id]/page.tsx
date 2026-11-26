"use client";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position, applyNodeChanges, applyEdgeChanges, useReactFlow,
  type Node, type Edge, type NodeChange, type EdgeChange, type Connection, type NodeProps,
} from "@xyflow/react";
import { ArrowLeft, Save, CheckCircle2, FlaskConical, Rocket, Pause, Play, Square, Undo2, Redo2, Users, Clock, FastForward, Trash2, AlertTriangle } from "lucide-react";
import { api, ApiError, useApi, useGlobal, useStream, fmt, can } from "@/components/hooks";
import { Badge, Button, Card, Confirm, DataTable, ErrorState, Field, Input, Loading, Notice, PageHeader, Select, Status, Tabs, Toggle, cx } from "@/components/ui";
import { Chart, bar } from "@/components/chart";

type Cat = "trigger" | "condition" | "action" | "flow";
type JNode = { id: string; type: Cat; kind: string; data: Record<string, unknown>; position?: { x: number; y: number } };
type JEdge = { id: string; source: string; target: string; sourceHandle?: string | null };
type Def = { nodes: JNode[]; edges: JEdge[]; exit?: { on_trigger_segment_exit?: boolean; rule?: unknown } };
type Issue = { level: "error" | "warning"; node?: string; edge?: string; message: string };
type Detail = {
  journey: { id: string; name: string; description: string | null; purpose: string; status: string; draft_definition: Def; published_version: number | null; strategy_category: string | null };
  versions: Array<{ version: number; strategy_version: number | null; status: string; published_by: string | null; published_at: string | null; approval_id: string | null }>;
  stats: { byStatus: Array<{ status: string; n: number }>; nodes: Array<{ node_id: string; entered: number; completed: number; errors: number }>; exits: Array<{ exit_reason: string; n: number }> };
  executions: Array<Record<string, unknown>>;
};
type Meta = {
  catalog: Record<Cat, string[]>; segments: Array<{ id: string; name: string; purpose: string }>; templates: Array<{ id: string; name: string; channel: string; purpose: string; status: string }>;
  offers: Array<{ id: string; name: string }>; tags: Array<{ key: string; name: string }>; events: Array<{ name: string }>; channels: Array<{ key: string; name: string }>;
  fields: Record<string, { label: string; type: string; options?: string[] }>;
};
type NData = { cat: Cat; kind: string; cfg: Record<string, unknown>; stats?: { entered: number; completed: number; errors: number }; sim?: { entered: number; blocked: number; exited: number }; invalid?: boolean; summary?: string };

const PROMO = ["membership", "marketing", "regulated_promotion"];
const CAT_STYLE: Record<Cat, { bar: string; label: string }> = {
  trigger: { bar: "#6366f1", label: "Trigger" }, condition: { bar: "#f59e0b", label: "Condition" }, action: { bar: "#14b8a6", label: "Action" }, flow: { bar: "#64748b", label: "Flow" },
};
const handlesFor = (cat: Cat, kind: string): string[] | null => {
  if (cat === "condition" || kind === "branch" || kind === "exit_condition") return ["yes", "no"];
  if (kind === "random_split" || kind === "ab_test") return ["a", "b"];
  return null;
};
const pretty = (k: string) => k.replace(/_/g, " ");

function summarize(kind: string, c: Record<string, unknown>, meta: Meta | null): string {
  const seg = (id: unknown) => meta?.segments.find((s) => s.id === id)?.name ?? String(id ?? "—");
  const tpl = (id: unknown) => meta?.templates.find((s) => s.id === id)?.name ?? String(id ?? "—");
  const off = (id: unknown) => meta?.offers.find((s) => s.id === id)?.name ?? String(id ?? "—");
  switch (kind) {
    case "segment_entry": case "segment_exit": case "segment_membership": return seg(c.segment_id);
    case "event_trigger": return String(c.event ?? "select event");
    case "scheduled": return String(c.cron ?? "cron not set");
    case "user_attribute": return `${c.field ?? "?"} ${c.op ?? "eq"} ${c.value ?? ""}`;
    case "user_tag": return `${c.has === false ? "lacks" : "has"} ${c.tag ?? "?"}`;
    case "event_condition": return `${c.event ?? "?"} ${c.op ?? "gte"} ${c.count ?? 1} in ${c.within_days ?? 7}d`;
    case "channel_availability": case "consent": return String(c.channel ?? "select channel");
    case "eligibility": case "evaluate_entitlement": case "issue_entitlement": return off(c.offer_id);
    case "compliance": return `purpose: ${c.purpose ?? "journey"}`;
    case "send_message": return `${c.channel ?? "?"} · ${tpl(c.template_id)}`;
    case "create_ticket": return String(c.subject ?? c.category ?? "ticket");
    case "update_tag": return `${c.add === false ? "remove" : "add"} ${c.tag ?? "?"}`;
    case "update_segment": return `${c.add === false ? "remove from" : "add to"} ${seg(c.segment_id)}`;
    case "call_webhook": return String(c.url ?? "url (mocked)");
    case "notify_employee": return String(c.message ?? "message");
    case "request_approval": return String(c.title ?? "approval");
    case "wait": case "delay": return c.strategy_param ? `strategy.${c.strategy_param} (fallback ${c.hours ?? 24}h)` : `${c.hours ?? "?"}h`;
    case "random_split": case "ab_test": return `A ${c.percent_a ?? 50}% / B ${100 - Number(c.percent_a ?? 50)}%`;
  }
  return "";
}

function JourneyNode({ data, selected }: NodeProps<Node<NData>>) {
  const st = CAT_STYLE[data.cat];
  const hs = handlesFor(data.cat, data.kind);
  return (
    <div className={cx("rounded-md border bg-panel shadow-sm min-w-[190px] max-w-[230px] text-[12px]", data.invalid ? "border-bad ring-2 ring-bad/40" : selected ? "border-accent ring-2 ring-[var(--ring)]" : "border-border")}>
      {data.cat !== "trigger" && <Handle type="target" position={Position.Top} style={{ background: "var(--border-strong)" }} />}
      <div className="h-1 rounded-t-md" style={{ background: st.bar }} />
      <div className="px-2.5 py-2">
        <div className="flex items-center gap-1.5"><span className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: st.bar }}>{st.label}</span><span className="text-[10px] text-faint">{pretty(data.kind)}</span></div>
        <div className="font-medium truncate mt-0.5">{String(data.cfg.label || pretty(data.kind))}</div>
        {data.summary && <div className="text-[11px] text-muted truncate">{data.summary}</div>}
        {(data.stats || data.sim) && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {data.stats && <><Badge tone="info" title="entered">↓ {data.stats.entered}</Badge><Badge tone="ok" title="completed">✓ {data.stats.completed}</Badge>{data.stats.errors > 0 && <Badge tone="bad" title="errors">! {data.stats.errors}</Badge>}</>}
            {data.sim && <><Badge tone="accent" title="simulated entered">sim {data.sim.entered}</Badge>{data.sim.blocked > 0 && <Badge tone="warn" title="blocked by compliance">blocked {data.sim.blocked}</Badge>}{data.sim.exited > 0 && <Badge title="exited">exit {data.sim.exited}</Badge>}</>}
          </div>
        )}
      </div>
      {data.kind !== "end" && (hs ? hs.map((h, i) => (
        <Handle key={h} id={h} type="source" position={Position.Bottom} style={{ left: `${i === 0 ? 28 : 72}%`, background: h === "no" || h === "b" ? "#f59e0b" : "#14b8a6", width: 9, height: 9 }}>
          <span className="absolute top-2 -translate-x-1/2 left-1/2 text-[9px] text-muted pointer-events-none">{h}</span>
        </Handle>
      )) : <Handle type="source" position={Position.Bottom} style={{ background: "var(--border-strong)" }} />)}
    </div>
  );
}
const nodeTypes = { jnode: JourneyNode };

const toRf = (def: Def): { nodes: Node<NData>[]; edges: Edge[] } => ({
  nodes: def.nodes.map((n, i) => ({ id: n.id, type: "jnode", position: n.position ?? { x: 0, y: i * 130 }, data: { cat: n.type, kind: n.kind, cfg: n.data ?? {} } })),
  edges: def.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null, label: e.sourceHandle ?? undefined })),
});
const fromRf = (nodes: Node<NData>[], edges: Edge[], exit: Def["exit"]): Def => ({
  nodes: nodes.map((n) => ({ id: n.id, type: n.data.cat, kind: n.data.kind, data: n.data.cfg, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } })),
  edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null })),
  exit,
});
const uid = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 100)}`;

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <ReactFlowProvider><Builder id={id} /></ReactFlowProvider>;
}

function Builder({ id }: { id: string }) {
  const { t, toast, me } = useGlobal();
  const detail = useApi<Detail>(`journeys/${id}`);
  const meta = useApi<Meta>("journeys/meta");
  const rf = useReactFlow();
  const [nodes, setNodes] = useState<Node<NData>[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [exit, setExit] = useState<Def["exit"]>({});
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [past, setPast] = useState<Array<{ nodes: Node<NData>[]; edges: Edge[] }>>([]);
  const [future, setFuture] = useState<Array<{ nodes: Node<NData>[]; edges: Edge[] }>>([]);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [sim, setSim] = useState<{ sample: number; counts: Record<string, { entered: number; blocked: number; exited: number }> } | null>(null);
  const [tab, setTab] = useState("builder");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | { action: string; title: string; body: string; danger?: boolean }>(null);
  const [publishResult, setPublishResult] = useState<{ version: number; status: string; approvalId?: string } | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (detail.data && !loaded) {
      const { nodes: n, edges: e } = toRf(detail.data.journey.draft_definition ?? { nodes: [], edges: [] });
      setNodes(n); setEdges(e); setExit(detail.data.journey.draft_definition?.exit ?? {}); setLoaded(true);
    }
  }, [detail.data, loaded]);
  useStream("stream?topics=journeys,delivery", (e) => { if (!e.ref_id || e.ref_id === id || e.topic === "delivery") detail.refresh(); });

  const snapshot = useCallback(() => { setPast((p) => [...p.slice(-49), { nodes, edges }]); setFuture([]); setDirty(true); }, [nodes, edges]);
  const undo = useCallback(() => { if (!past.length) return; const last = past[past.length - 1]; setFuture((f) => [{ nodes, edges }, ...f]); setNodes(last.nodes); setEdges(last.edges); setPast((p) => p.slice(0, -1)); setDirty(true); }, [past, nodes, edges]);
  const redo = useCallback(() => { if (!future.length) return; const next = future[0]; setPast((p) => [...p, { nodes, edges }]); setNodes(next.nodes); setEdges(next.edges); setFuture((f) => f.slice(1)); setDirty(true); }, [future, nodes, edges]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tg = e.target as HTMLElement; if (["INPUT", "TEXTAREA", "SELECT"].includes(tg.tagName)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  }, [undo, redo]);

  const onNodesChange = useCallback((ch: NodeChange<Node<NData>>[]) => {
    if (ch.some((c) => c.type === "remove")) snapshot();
    if (ch.some((c) => c.type === "position" && c.dragging === false) || ch.some((c) => c.type === "remove")) setDirty(true);
    setNodes((ns) => applyNodeChanges(ch, ns));
  }, [snapshot]);
  const onEdgesChange = useCallback((ch: EdgeChange[]) => { if (ch.some((c) => c.type === "remove")) { snapshot(); } setEdges((es) => applyEdgeChanges(ch, es)); }, [snapshot]);
  const onConnect = useCallback((c: Connection) => {
    if (c.source === c.target) return;
    snapshot();
    setEdges((es) => [...es.filter((e) => !(e.source === c.source && (e.sourceHandle ?? null) === (c.sourceHandle ?? null) && e.target === c.target)), { id: uid("e"), source: c.source!, target: c.target!, sourceHandle: c.sourceHandle ?? null, label: c.sourceHandle ?? undefined }]);
  }, [snapshot]);

  const addNode = useCallback((cat: Cat, kind: string, pos?: { x: number; y: number }) => {
    snapshot();
    const maxY = nodes.reduce((m, n) => Math.max(m, n.position.y), -130);
    const defaults: Record<string, Record<string, unknown>> = { wait: { hours: 24 }, delay: { hours: 4 }, random_split: { percent_a: 50 }, ab_test: { percent_a: 50 }, event_condition: { op: "gte", count: 1, within_days: 7 }, user_attribute: { op: "eq" }, user_tag: { has: true }, update_tag: { add: true }, update_segment: { add: true } };
    const n: Node<NData> = { id: uid(cat[0]), type: "jnode", position: pos ?? { x: 0, y: maxY + 130 }, data: { cat, kind, cfg: { ...(defaults[kind] ?? {}) } }, selected: true };
    setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), n]);
  }, [nodes, snapshot]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const v = e.dataTransfer.getData("application/aec-node"); if (!v) return;
    const [cat, kind] = v.split(":");
    addNode(cat as Cat, kind, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  }, [addNode, rf]);

  const selected = nodes.find((n) => n.selected);
  const updateCfg = (patch: Record<string, unknown>) => {
    if (!selected) return;
    snapshot();
    setNodes((ns) => ns.map((n) => (n.id === selected.id ? { ...n, data: { ...n.data, cfg: { ...n.data.cfg, ...patch } } } : n)));
  };
  const deleteSelected = () => { if (!selected) return; snapshot(); setNodes((ns) => ns.filter((n) => n.id !== selected.id)); setEdges((es) => es.filter((e) => e.source !== selected.id && e.target !== selected.id)); };

  const statMap = useMemo(() => new Map((detail.data?.stats.nodes ?? []).map((s) => [s.node_id, s])), [detail.data]);
  const invalidNodes = useMemo(() => new Set((issues ?? []).filter((i) => i.level === "error" && i.node).map((i) => i.node!)), [issues]);
  const invalidEdges = useMemo(() => new Set((issues ?? []).filter((i) => i.edge).map((i) => i.edge!)), [issues]);
  const displayNodes = useMemo(() => nodes.map((n) => ({ ...n, data: { ...n.data, summary: summarize(n.data.kind, n.data.cfg, meta.data), stats: statMap.get(n.id), sim: sim?.counts[n.id], invalid: invalidNodes.has(n.id) } })), [nodes, meta.data, statMap, sim, invalidNodes]);
  const displayEdges = useMemo(() => edges.map((e) => ({ ...e, label: e.sourceHandle ?? undefined, style: invalidEdges.has(e.id) ? { stroke: "var(--bad)", strokeWidth: 2 } : undefined, labelStyle: { fill: "var(--muted)", fontSize: 10 }, labelBgStyle: { fill: "var(--panel)" } })), [edges, invalidEdges]);

  const def = () => fromRf(nodes, edges, exit);
  const save = async (quiet = false) => {
    const r = await api<{ ok: boolean; issues: Issue[] }>(`journeys/${id}`, { method: "PUT", body: { definition: def() } });
    setDirty(false); setIssues(r.issues);
    if (!quiet) toast({ kind: "success", title: "Draft saved", body: `${r.issues.filter((i) => i.level === "error").length} errors, ${r.issues.filter((i) => i.level === "warning").length} warnings` });
    return r;
  };
  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(action);
    try {
      if (["validate", "simulate", "publish"].includes(action)) await save(true);
      const r = await api<Record<string, unknown>>(`journeys/${id}/action`, { body: { action, ...extra } });
      if (action === "validate") { setIssues(r.issues as Issue[]); toast({ kind: (r.issues as Issue[]).some((i) => i.level === "error") ? "warning" : "success", title: "Validation complete", body: `${(r.issues as Issue[]).length} issue(s)` }); }
      else if (action === "simulate") { setSim(r as unknown as typeof sim); setIssues(r.issues as Issue[]); toast({ kind: "info", title: "Simulation complete", body: `${r.sample} sample players run through the draft — no messages sent` }); }
      else if (action === "publish") { setPublishResult(r as unknown as typeof publishResult); toast({ kind: r.status === "published" ? "success" : "info", title: r.status === "published" ? `Published v${r.version}` : `v${r.version} sent for approval` }); }
      else if (action === "enroll_segment") toast({ kind: "success", title: "Enrollment", body: `${r.enrolled} enrolled, ${r.duplicates} already in journey (no duplicates)` });
      else if (action === "tick") toast({ kind: "info", title: "Processed due steps", body: `${r.processed} execution(s) advanced` });
      else if (action === "fast_forward") toast({ kind: "warning", title: "Mock clock advanced", body: `+${r.advanced_hours}h; ${r.processed} execution(s) advanced` });
      else toast({ kind: "success", title: `Journey ${action}d` });
      detail.refresh();
    } catch (e) {
      const err = e as ApiError;
      if (Array.isArray(err.details)) setIssues(err.details as Issue[]);
      toast({ kind: "error", title: `${action} failed`, body: err.message });
    }
    setBusy(null); setConfirm(null);
  };

  if (detail.error) return <ErrorState error={detail.error} onRetry={detail.refresh} />;
  if (!detail.data || !meta.data) return <Loading rows={8} />;
  const j = detail.data.journey; const m = meta.data;
  const writable = can(me, "journeys.write"); const publishable = can(me, "journeys.publish");
  const errors = (issues ?? []).filter((i) => i.level === "error"); const warnings = (issues ?? []).filter((i) => i.level === "warning");

  return (
    <div className="space-y-3">
      <PageHeader
        title={<span className="flex items-center gap-2"><Link href="/journeys" className="text-muted hover:text-fg" aria-label="Back"><ArrowLeft size={16} /></Link>{j.name}<Status value={j.status} /><Badge tone={PROMO.includes(j.purpose) ? "warn" : "info"}>{j.purpose}</Badge>{dirty && <Badge tone="warn">unsaved</Badge>}</span>}
        subtitle={<>{t("journeys")} · published {j.published_version ? `v${j.published_version}` : "—"}{j.strategy_category && <> · strategy <code className="font-mono text-xs">{j.strategy_category}</code></>}</>}
        actions={<>
          <Button size="sm" variant="ghost" onClick={undo} disabled={!past.length} aria-label="Undo" title="Undo (⌘Z)"><Undo2 size={14} /></Button>
          <Button size="sm" variant="ghost" onClick={redo} disabled={!future.length} aria-label="Redo" title="Redo (⇧⌘Z)"><Redo2 size={14} /></Button>
          {writable && <Button size="sm" onClick={() => { setBusy("save"); save().catch((e) => toast({ kind: "error", title: "Save failed", body: (e as Error).message })).finally(() => setBusy(null)); }} loading={busy === "save"}><Save size={13} />Save draft</Button>}
          <Button size="sm" onClick={() => act("validate")} loading={busy === "validate"}><CheckCircle2 size={13} />Validate</Button>
          <Button size="sm" onClick={() => act("simulate")} loading={busy === "simulate"}><FlaskConical size={13} />{t("simulate")}</Button>
          {publishable && <Button size="sm" variant="primary" onClick={() => setConfirm({ action: "publish", title: "Publish journey?", body: PROMO.includes(j.purpose) ? "This is a promotional journey — publishing creates an approval request. A different approver must approve before it goes live." : "The draft will be validated and published as a new version. Running executions stay pinned to their current version; new enrollments use the new version." })} loading={busy === "publish"}><Rocket size={13} />Publish</Button>}
          {publishable && j.status === "active" && <Button size="sm" onClick={() => act("pause")}><Pause size={13} />Pause</Button>}
          {publishable && (j.status === "paused" || j.status === "stopped") && j.published_version && <Button size="sm" onClick={() => act("resume")}><Play size={13} />Resume</Button>}
          {publishable && j.status !== "stopped" && j.published_version && <Button size="sm" variant="ghost" onClick={() => setConfirm({ action: "stop", title: "Stop journey?", body: "All active and waiting executions will exit with reason journey_stopped.", danger: true })}><Square size={13} />Stop</Button>}
        </>} />

      {publishResult && <Notice tone={publishResult.status === "published" ? "ok" : "warn"}>{publishResult.status === "published" ? `Version ${publishResult.version} published and active.` : <>Version {publishResult.version} is pending approval — <Link className="underline" href={`/compliance?tab=approvals&id=${publishResult.approvalId}`}>open approval</Link>.</>}</Notice>}
      {issues && (errors.length || warnings.length) ? (
        <div className="rounded-md border border-border bg-panel p-2.5 space-y-1 max-h-36 overflow-y-auto scroll-thin">
          {issues.map((i, k) => <button key={k} className="flex items-center gap-2 text-[12px] w-full text-left hover:bg-panel-2 rounded px-1" onClick={() => i.node && setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === i.node })))}>
            <AlertTriangle size={12} className={i.level === "error" ? "text-bad" : "text-warn"} /><Badge tone={i.level === "error" ? "bad" : "warn"}>{i.level}</Badge>{i.node && <code className="font-mono text-[11px]">{i.node}</code>}<span>{i.message}</span></button>)}
        </div>
      ) : issues ? <Notice tone="ok">No validation issues.</Notice> : null}
      {sim && <Notice tone="info">Simulation: {sim.sample} real players from the trigger segment walked through the draft (side-effect free; compliance checked per send). Per-node counts shown as “sim” badges. <button className="underline ml-1" onClick={() => setSim(null)}>clear</button></Notice>}

      <Tabs value={tab} onChange={setTab} tabs={[{ key: "builder", label: "Builder" }, { key: "versions", label: "Versions", count: detail.data.versions.length }, { key: "executions", label: "Executions", count: detail.data.executions.length }, { key: "stats", label: "Stats" }]} />

      {tab === "builder" && (
        <div className="grid grid-cols-1 lg:grid-cols-[180px_1fr_300px] gap-3">
          <aside className="rounded-lg border border-border bg-panel p-2 space-y-3 max-h-[calc(100dvh-260px)] overflow-y-auto scroll-thin" aria-label="Node palette">
            <div className="text-[11px] text-faint px-1">Drag onto the canvas or click to add</div>
            {(Object.keys(m.catalog) as Cat[]).map((cat) => (
              <div key={cat}>
                <div className="text-[10.5px] uppercase tracking-wide font-semibold px-1 mb-1" style={{ color: CAT_STYLE[cat].bar }}>{CAT_STYLE[cat].label}s</div>
                <div className="space-y-0.5">{m.catalog[cat].map((kind) => (
                  <button key={kind} draggable={writable} disabled={!writable} onDragStart={(e) => { e.dataTransfer.setData("application/aec-node", `${cat}:${kind}`); e.dataTransfer.effectAllowed = "move"; }} onClick={() => addNode(cat, kind)}
                    className="w-full text-left text-[12px] px-2 py-1 rounded border border-transparent hover:border-border hover:bg-panel-2 cursor-grab capitalize disabled:opacity-50">{pretty(kind)}</button>
                ))}</div>
              </div>
            ))}
          </aside>
          <div ref={wrapper} className="rounded-lg border border-border bg-panel-2 h-[calc(100dvh-260px)] min-h-[480px]" onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }} onDrop={onDrop}>
            <ReactFlow nodes={displayNodes} edges={displayEdges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
              onNodeDragStart={() => snapshot()} fitView fitViewOptions={{ padding: 0.2 }} deleteKeyCode={writable ? ["Delete", "Backspace"] : null} nodesDraggable={writable} nodesConnectable={writable}
              defaultEdgeOptions={{ type: "smoothstep" }} proOptions={{ hideAttribution: true }} colorMode="system">
              <Background gap={18} size={1} />
              <Controls />
              <MiniMap pannable zoomable nodeColor={(n) => CAT_STYLE[(n.data as NData).cat]?.bar ?? "#888"} />
            </ReactFlow>
          </div>
          <aside className="rounded-lg border border-border bg-panel p-3 max-h-[calc(100dvh-260px)] overflow-y-auto scroll-thin space-y-3" aria-label="Properties">
            {selected ? <NodeForm n={selected} meta={m} purpose={j.purpose} onChange={updateCfg} onDelete={deleteSelected} disabled={!writable} />
              : <div className="space-y-3">
                <div className="text-[13px] font-semibold">Journey settings</div>
                <div className="text-xs text-muted">Select a node to edit its properties.</div>
                <label className="flex items-start gap-2 text-[12.5px]"><Toggle checked={!!exit?.on_trigger_segment_exit} disabled={!writable} onChange={(v) => { setExit({ ...exit, on_trigger_segment_exit: v }); setDirty(true); }} label="Exit when player leaves trigger segment" /><span>Exit when player leaves trigger segment<span className="block text-faint text-[11px]">Pending steps (e.g. reminders) are cancelled immediately.</span></span></label>
                <Notice tone="info">Compliance (consent, exclusions, frequency caps, quiet hours) is enforced at every send — it cannot be bypassed by journey design.</Notice>
                <div className="text-[11px] text-faint">{nodes.length} nodes · {edges.length} connections</div>
              </div>}
          </aside>
        </div>
      )}

      {tab === "versions" && (
        <Card title="Version history" subtitle="Running executions stay pinned to their version; new enrollments use the latest published version." pad={false}><div className="p-3">
          <DataTable rows={detail.data.versions as unknown as Record<string, unknown>[]} rowKey={(r) => `v${r.version}`} cols={[
            { key: "version", label: "Version", render: (r) => `v${r.version}` }, { key: "status", label: "Status", render: (r) => <Status value={String(r.status)} /> },
            { key: "strategy_version", label: "Strategy pin", render: (r) => (r.strategy_version ? `v${r.strategy_version}` : "–") }, { key: "published_by", label: "Published by", render: (r) => String(r.published_by ?? "–") },
            { key: "published_at", label: "Published", render: (r) => fmt.date(r.published_at) },
            { key: "approval_id", label: "Approval", render: (r) => (r.approval_id ? <Link className="text-accent underline" href={`/compliance?tab=approvals&id=${r.approval_id}`}>{String(r.approval_id)}</Link> : "–") },
          ]} />
        </div></Card>
      )}

      {tab === "executions" && (
        <Card title="Executions" subtitle="Latest 50" actions={<>
          {publishable && <Button size="sm" onClick={() => act("enroll_segment")} loading={busy === "enroll_segment"}><Users size={13} />Enroll segment now</Button>}
          {writable && <Button size="sm" onClick={() => act("tick")} loading={busy === "tick"}><Clock size={13} />Process due steps</Button>}
          {writable && <Button size="sm" variant="ghost" onClick={() => setConfirm({ action: "fast_forward", title: "Fast-forward mock clock 24h?", body: "MOCK MODE ONLY: advances the platform clock by 24 hours so waits elapse, then processes due steps. Recorded in the audit log. Never available against real integrations." })}><FastForward size={13} />Fast-forward 24h (mock clock)</Button>}
        </>} pad={false}><div className="p-3">
          <DataTable rows={detail.data.executions} exportName={`journey-${id}-executions`} search={(r) => `${r.player_id} ${r.status}`} cols={[
            { key: "player_id", label: "Player", render: (r) => <Link className="text-accent" href={`/audience/${r.player_id}`}>{String(r.player_id)}</Link> },
            { key: "version", label: "Version", render: (r) => `v${r.version}` }, { key: "status", label: "Status", render: (r) => <Status value={String(r.status)} /> },
            { key: "current_node", label: "Current node", render: (r) => <code className="font-mono text-[11px]">{String(r.current_node ?? "–")}</code> },
            { key: "wake_at", label: "Wakes", render: (r) => fmt.date(r.wake_at) }, { key: "strategy_version", label: "Strategy", render: (r) => (r.strategy_version ? `v${r.strategy_version}` : "–") },
            { key: "exit_reason", label: "Exit reason", render: (r) => String(r.exit_reason ?? "–") },
            { key: "stop", label: "", render: (r) => publishable && ["active", "waiting"].includes(String(r.status)) ? <Button size="sm" variant="ghost" onClick={async (e) => { e.stopPropagation(); try { await api(`journeys/executions/${r.id}/stop`, { body: {} }); toast({ kind: "success", title: "Execution stopped" }); detail.refresh(); } catch (er) { toast({ kind: "error", title: (er as Error).message }); } }}>Stop</Button> : null },
          ]} />
        </div></Card>
      )}

      {tab === "stats" && (
        <div className="grid lg:grid-cols-2 gap-3">
          <Card title="Executions by status">{detail.data.stats.byStatus.length ? <Chart height={240} option={bar(detail.data.stats.byStatus.map((s) => s.status), [{ name: "Executions", data: detail.data.stats.byStatus.map((s) => s.n) }])} /> : <div className="text-xs text-muted">No executions yet.</div>}</Card>
          <Card title="Exit reasons">{detail.data.stats.exits.length ? <Chart height={240} option={bar(detail.data.stats.exits.map((s) => s.exit_reason), [{ name: "Exits", data: detail.data.stats.exits.map((s) => s.n) }])} /> : <div className="text-xs text-muted">No exits recorded.</div>}</Card>
          <Card title="Per-node counts (published version)" className="lg:col-span-2" pad={false}><div className="p-3">
            <DataTable dense rows={detail.data.stats.nodes as unknown as Record<string, unknown>[]} rowKey={(r) => String(r.node_id)} cols={[
              { key: "node_id", label: "Node", render: (r) => { const n = nodes.find((x) => x.id === r.node_id); return <span><code className="font-mono text-[11px]">{String(r.node_id)}</code> <span className="text-muted">{n ? String(n.data.cfg.label || pretty(n.data.kind)) : ""}</span></span>; } },
              { key: "entered", label: "Entered", align: "right" }, { key: "completed", label: "Completed", align: "right" },
              { key: "errors", label: "Errors / retries", align: "right", render: (r) => <span className={Number(r.errors) ? "text-bad font-medium" : ""}>{String(r.errors)}</span> },
            ]} />
          </div></Card>
        </div>
      )}

      <Confirm open={!!confirm} onClose={() => setConfirm(null)} title={confirm?.title ?? ""} body={confirm?.body ?? ""} danger={confirm?.danger} loading={!!busy}
        onConfirm={() => confirm && act(confirm.action, confirm.action === "fast_forward" ? { hours: 24 } : {})} confirmLabel="Continue" />
    </div>
  );
}

function NodeForm({ n, meta, purpose, onChange, onDelete, disabled }: { n: Node<NData>; meta: Meta; purpose: string; onChange: (p: Record<string, unknown>) => void; onDelete: () => void; disabled: boolean }) {
  const c = n.data.cfg; const k = n.data.kind;
  const sel = (key: string, options: Array<{ value: string; label: string } | string>, label: string, hint?: string) => (
    <Field label={label} hint={hint}><Select disabled={disabled} value={String(c[key] ?? "")} onChange={(e) => onChange({ [key]: e.target.value || undefined })} options={[{ value: "", label: "— select —" }, ...options]} /></Field>
  );
  const txt = (key: string, label: string, type = "text", hint?: string) => (
    <Field label={label} hint={hint}><Input disabled={disabled} type={type} value={c[key] == null ? "" : String(c[key])} onChange={(e) => onChange({ [key]: type === "number" ? (e.target.value === "" ? undefined : Number(e.target.value)) : e.target.value })} /></Field>
  );
  const bool = (key: string, label: string, def = true) => (
    <label className="flex items-center gap-2 text-[12.5px]"><Toggle disabled={disabled} checked={c[key] === undefined ? def : !!c[key]} onChange={(v) => onChange({ [key]: v })} label={label} />{label}</label>
  );
  const segs = meta.segments.map((s) => ({ value: s.id, label: `${s.name} (${s.purpose})` }));
  const chans = meta.channels.map((x) => ({ value: x.key, label: x.name }));
  const offers = meta.offers.map((o) => ({ value: o.id, label: o.name }));
  const tpls = meta.templates.filter((t) => !c.channel || t.channel === c.channel).map((t) => ({ value: t.id, label: `${t.name} · ${t.purpose}` }));
  const tpl = meta.templates.find((t) => t.id === c.template_id);
  const field = meta.fields[String(c.field ?? "")];
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between"><div><div className="text-[10.5px] uppercase font-semibold" style={{ color: CAT_STYLE[n.data.cat].bar }}>{CAT_STYLE[n.data.cat].label}</div><div className="text-[13px] font-semibold capitalize">{pretty(k)}</div></div>
        {!disabled && <Button size="sm" variant="ghost" onClick={onDelete} aria-label="Delete node"><Trash2 size={13} /></Button>}</div>
      <div className="text-[11px] text-faint">id <code className="font-mono">{n.id}</code></div>
      {txt("label", "Label")}
      {(k === "segment_entry" || k === "segment_exit" || k === "segment_membership") && sel("segment_id", segs, "Segment")}
      {k === "event_trigger" && sel("event", meta.events.map((e) => e.name), "Event")}
      {k === "scheduled" && txt("cron", "Cron expression", "text", "e.g. 0 9 * * * (Asia/Manila)")}
      {(k === "manual" || k === "api" || k === "webhook") && <Notice tone="info">{k === "manual" ? "Enroll players manually from the Executions tab." : `Enrollment via ${k === "api" ? "POST /api/journeys/:id/action" : "inbound webhook (mocked until an integration is configured)"}.`}</Notice>}
      {k === "user_attribute" && <>
        {sel("field", Object.entries(meta.fields).map(([f, v]) => ({ value: f, label: v.label })), "Field")}
        {sel("op", ["eq", "neq", "gt", "gte", "lt", "lte", "in", "contains", "is_null", "not_null", "within_last_days", "older_than_days"], "Operator")}
        {field?.options ? sel("value", field.options, "Value") : txt("value", "Value", field?.type === "number" ? "number" : "text")}
      </>}
      {k === "user_tag" && <>{sel("tag", meta.tags.map((t) => ({ value: t.key, label: t.name })), "Tag")}{bool("has", "Player has tag")}</>}
      {k === "event_condition" && <>{sel("event", meta.events.map((e) => e.name), "Event")}{sel("op", ["gte", "lte", "eq"], "Operator")}{txt("count", "Count", "number")}{txt("within_days", "Within days", "number")}</>}
      {(k === "channel_availability" || k === "consent") && sel("channel", chans, "Channel", k === "consent" ? `Checks ${PROMO.includes(purpose) ? "marketing" : "service"} consent for this journey's purpose` : undefined)}
      {(k === "eligibility" || k === "evaluate_entitlement" || k === "issue_entitlement") && sel("offer_id", offers, "Offer", k === "issue_entitlement" ? "Issuance is idempotent and budget-checked; journeys with issuance need approval to publish." : "Deterministic policy engine decision")}
      {k === "compliance" && sel("purpose", ["service", "security", "operational", "protective", "membership", "marketing"], "Purpose", "Defaults to the journey purpose")}
      {k === "send_message" && <>
        {sel("channel", chans, "Channel")}
        {sel("template_id", tpls, "Approved template", "Only approved templates are listed")}
        {tpl && PROMO.includes(tpl.purpose) && !PROMO.includes(purpose) && <Notice tone="bad">Promotional template in a {purpose} journey — validation will reject this.</Notice>}
      </>}
      {k === "create_ticket" && <>{sel("category", ["general", "kyc_help", "game_loading", "payment", "account", "responsible_gaming"], "Category")}{txt("subject", "Subject")}</>}
      {k === "update_tag" && <>{sel("tag", meta.tags.map((t) => ({ value: t.key, label: t.name })), "Tag")}{bool("add", "Add tag (off = remove)")}</>}
      {k === "update_segment" && <>{sel("segment_id", segs, "Segment")}{bool("add", "Add to segment (off = remove)")}</>}
      {k === "call_webhook" && <>{txt("url", "URL")}<Notice tone="warn">Outbound webhooks are mocked until an integration is enabled.</Notice></>}
      {k === "notify_employee" && txt("message", "Message")}
      {k === "request_approval" && txt("title", "Approval title")}
      {(k === "wait" || k === "delay") && <>{txt("hours", "Hours", "number", "Fallback if no strategy parameter")}{sel("strategy_param", ["reminder_wait_hours", "stalled_after_hours", "evaluation_window_hours"], "Strategy parameter (optional)", "Reads the value from the strategy version pinned to each execution")}</>}
      {(k === "random_split" || k === "ab_test") && txt("percent_a", "Percent to branch A", "number")}
      {k === "branch" && <Notice tone="info">Branch rules use the segment rule format; configure via API or use a Condition node for common cases.</Notice>}
      {handlesFor(n.data.cat, k) && <div className="text-[11px] text-faint">Outputs: {handlesFor(n.data.cat, k)!.join(" / ")} — connect each handle.</div>}
    </div>
  );
}
