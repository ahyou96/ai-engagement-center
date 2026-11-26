"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Lock, OctagonAlert, RefreshCw, ShieldCheck, CheckCircle2, XCircle } from "lucide-react";
import { api, ApiError, can, fmt, useApi, useGlobal, useStream } from "@/components/hooks";
import { Badge, Button, Card, Confirm, DataTable, Drawer, ErrorState, Field, Input, JsonView, KV, Loading, Notice, PageHeader, Select, Status, Tabs, Textarea, Toggle } from "@/components/ui";

type R = Record<string, unknown>;
type Policy = { key: string; name: string; description: string; mandatory: number; enabled: number; config: Record<string, unknown>; updated_by: string | null; updated_at: string; effective: { enabled: boolean } };
type Approval = { id: string; entity_type: string; entity_id: string; title: string; summary: string | null; evidence: unknown[]; risk: string; status: string; required_levels: number; current_level: number; requested_by: string; expires_at: string | null; created_at: string; decided_at: string | null };

const TABS = [{ key: "policies", label: "Policies" }, { key: "approvals", label: "Approval Center" }, { key: "audit", label: "Audit Center" }, { key: "exclusions", label: "Exclusions" }, { key: "validation", label: "Validation" }, { key: "checks", label: "Check log" }, { key: "rg", label: "Responsible gaming" }];

function Inner() {
  const { t, me, toast } = useGlobal(); const sp = useSearchParams(); const router = useRouter();
  const tab = sp.get("tab") ?? "policies";
  const [estop, setEstop] = useState(false);
  const active = me?.emergency_stop;
  return (
    <div className="space-y-4">
      <PageHeader title={t("compliance")} subtitle="Mandatory cross-platform enforcement layer — every send and every entitlement passes through it; AI agents cannot bypass it"
        actions={can(me, "workflows.emergency_stop") && <Button size="sm" variant={active ? "default" : "danger"} onClick={() => setEstop(true)}><OctagonAlert size={13} />{active ? "Clear emergency stop" : t("emergency_stop")}</Button>} />
      <Tabs tabs={TABS} value={tab} onChange={(k) => router.replace(`/compliance?tab=${k}`)} />
      {tab === "policies" && <Policies />}
      {tab === "approvals" && <Approvals initialId={sp.get("id")} />}
      {tab === "audit" && <Audit />}
      {tab === "exclusions" && <Exclusions />}
      {tab === "validation" && <Validation />}
      {tab === "checks" && <Checks />}
      {tab === "rg" && <RgPanel />}
      <Confirm open={estop} onClose={() => setEstop(false)} danger={!active} title={active ? "Clear emergency stop?" : "Activate EMERGENCY STOP?"} confirmLabel={active ? "Clear" : "Activate emergency stop"}
        body={active ? "Workflows may start again; paused journeys and campaigns must be resumed individually." : "Stops all running AI workflows, pauses active journeys and approved campaigns; only simulations may run. Protective, security and regulatory messages remain allowed. Audited."}
        onConfirm={async () => { try { await api("system/emergency-stop", { body: { on: !active } }); toast({ kind: active ? "success" : "warning", title: active ? "Emergency stop cleared" : "Emergency stop activated" }); } catch (e) { toast({ kind: "error", title: (e as Error).message }); } setEstop(false); }} />
    </div>
  );
}

function Policies() {
  const p = useApi<Policy[]>("compliance/policies"); const { me, toast } = useGlobal();
  const [edit, setEdit] = useState<Policy | null>(null); const [cfg, setCfg] = useState<Record<string, unknown>>({}); const [busy, setBusy] = useState(false);
  const allowed = can(me, "compliance.write");
  const save = async (key: string, body: R) => { setBusy(true); try { await api(`compliance/policies/${key}`, { method: "PUT", body }); toast({ kind: "success", title: "Policy updated" }); p.refresh(); setEdit(null); } catch (e) { toast({ kind: "error", title: "Update failed", body: (e as Error).message }); } setBusy(false); };
  return <div className="space-y-3">
    <ErrorState error={p.error} onRetry={p.refresh} />
    {!p.data ? <Loading /> : <div className="grid md:grid-cols-2 gap-3">{p.data.map((x) => (
      <Card key={x.key} title={<span className="flex items-center gap-2">{x.mandatory ? <Lock size={13} className="text-warn" /> : <ShieldCheck size={13} className="text-muted" />}{x.name}</span>}
        actions={<><Badge tone={x.effective?.enabled ? "ok" : "neutral"}>{x.effective?.enabled ? "enforced" : "off"}</Badge><Toggle checked={!!x.enabled} disabled={!!x.mandatory || !allowed} label={x.name} onChange={(v) => save(x.key, { enabled: v })} /></>}>
        <div className="text-xs text-muted">{x.description}</div>
        {x.mandatory ? <div className="text-[11px] text-warn mt-1">Mandatory — cannot be disabled</div> : null}
        {Object.keys(x.config).length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{Object.entries(x.config).map(([k, v]) => <Badge key={k}>{k}: {String(v)}</Badge>)}</div>}
        {x.key === "age_eligibility" && <Notice tone="warn" className="mt-2">Demo default 21+. Validate applicable Philippine regulatory requirements before production.</Notice>}
        <div className="flex items-center gap-2 mt-2">{allowed && Object.keys(x.config).length > 0 && <Button size="sm" onClick={() => { setEdit(x); setCfg(x.config); }}>Edit configuration</Button>}<span className="text-[11px] text-faint ml-auto">Updated {fmt.ago(x.updated_at)}{x.updated_by ? ` by ${x.updated_by}` : ""}</span></div>
      </Card>))}</div>}
    <Drawer open={!!edit} onClose={() => setEdit(null)} title={`Configure: ${edit?.name}`} width={440} footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => edit && save(edit.key, { config: cfg })}>Save</Button></>}>
      <div className="space-y-3">{Object.entries(cfg).map(([k, v]) => <Field key={k} label={k} hint={k === "min_age" ? "Must be ≥ 18 (server-enforced)" : undefined}><Input type="number" value={String(v)} onChange={(e) => setCfg({ ...cfg, [k]: Number(e.target.value) })} /></Field>)}</div>
    </Drawer>
  </div>;
}

function Approvals({ initialId }: { initialId: string | null }) {
  const [status, setStatus] = useState("pending");
  const list = useApi<Approval[]>(`approvals${status ? `?status=${status}` : ""}`);
  const [sel, setSel] = useState<string | null>(initialId);
  useStream("stream?topics=approvals", () => list.refresh());
  return <div className="space-y-3">
    <div className="flex items-center gap-2"><Select value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: "pending", label: "Pending" }, { value: "approved", label: "Approved" }, { value: "rejected", label: "Rejected" }, { value: "changes_requested", label: "Changes requested" }, { value: "expired", label: "Expired" }, { value: "", label: "All" }]} aria-label="Status filter" /><Button size="sm" variant="ghost" onClick={list.refresh} aria-label="Refresh"><RefreshCw size={13} /></Button>
      <span className="text-xs text-muted">High/critical risk requires two different approvers. Requesters cannot approve their own requests.</span></div>
    <ErrorState error={list.error} onRetry={list.refresh} />
    {!list.data ? <Loading /> : <DataTable rows={list.data as unknown as R[]} onRow={(r) => setSel(String(r.id))} exportName="approvals" search={(r) => `${r.title} ${r.entity_type}`} cols={[
      { key: "title", label: "Request", render: (r) => <div className="max-w-[420px]"><div className="font-medium truncate">{String(r.title)}</div><div className="text-[11px] text-muted truncate">{String(r.summary ?? "")}</div></div> },
      { key: "entity_type", label: "Type", render: (r) => <Badge>{String(r.entity_type).replace(/_/g, " ")}</Badge> }, { key: "risk", label: "Risk", render: (r) => <Status value={String(r.risk)} /> },
      { key: "lvl", label: "Level", render: (r) => `${r.current_level}/${r.required_levels}` }, { key: "status", label: "Status", render: (r) => <Status value={String(r.status)} /> },
      { key: "requested_by", label: "Requested by" }, { key: "created_at", label: "Created", render: (r) => fmt.ago(r.created_at) }, { key: "expires_at", label: "Expires", render: (r) => fmt.date(r.expires_at) }]} />}
    <ApprovalDrawer id={sel} onClose={() => setSel(null)} onDone={list.refresh} />
  </div>;
}

function ApprovalDrawer({ id, onClose, onDone }: { id: string | null; onClose: () => void; onDone: () => void }) {
  const d = useApi<{ approval: Approval; history: Array<{ id: number; level: number; action: string; actor: string; comment: string | null; at: string }>; entity: unknown }>(id ? `approvals/${id}` : null, [id]);
  const { me, toast } = useGlobal(); const [comment, setComment] = useState(""); const [busy, setBusy] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setComment(""); setErr(null); }, [id]);
  const decide = async (action: string) => {
    setBusy(action); setErr(null);
    try { const a = await api<Approval>(`approvals/${id}`, { body: { action, comment: comment || undefined } }); toast({ kind: "success", title: `Approval ${a.status.replace(/_/g, " ")}`, body: a.status === "pending" ? `Level ${a.current_level}/${a.required_levels} — needs another approver` : undefined }); d.refresh(); onDone(); }
    catch (e) { const m = (e as ApiError).message; setErr((e as ApiError).status === 403 ? `Not allowed: ${m}` : m); toast({ kind: "error", title: "Decision failed", body: m }); }
    setBusy(null);
  };
  const a = d.data?.approval; const pending = a?.status === "pending"; const allowed = can(me, "approvals.decide");
  return <Drawer open={!!id} onClose={onClose} width={680} title={a?.title ?? "Approval"}
    footer={pending && allowed ? <><Button onClick={() => decide("request_changes")} loading={busy === "request_changes"}>Request modification</Button><Button variant="danger" onClick={() => decide("reject")} loading={busy === "reject"}>Reject</Button><Button variant="primary" onClick={() => decide("approve")} loading={busy === "approve"}>Approve</Button></> : undefined}>
    {!a ? <Loading /> : <div className="space-y-4">
      <KV items={[["Status", <Status key="s" value={a.status} />], ["Risk", <Status key="r" value={a.risk} />], ["Approval level", `${a.current_level} of ${a.required_levels}`], ["Entity", <code key="e" className="text-xs">{a.entity_type}:{a.entity_id}</code>], ["Requested by", a.requested_by], ["Created", fmt.date(a.created_at)], ["Expires", fmt.date(a.expires_at)], ["Summary", a.summary ?? "–"]]} />
      {err && <Notice tone="bad">{err}</Notice>}
      {pending && !allowed && <Notice tone="warn">Your role cannot decide approvals.</Notice>}
      {pending && allowed && <Field label="Comment (recorded in audit log)"><Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Reason / conditions" /></Field>}
      {a.entity_type === "workflow_decision" && <Notice tone="info">Approving resumes the AI workflow at the Execution step. To modify proposed actions before approving, use Opportunity Finder (human intervention).</Notice>}
      <Card title="Supporting evidence"><JsonView value={a.evidence} /></Card>
      {d.data?.entity != null && <Card title="Entity preview"><JsonView value={d.data.entity} /></Card>}
      <Card title="Approval history" pad={false}><div className="divide-y divide-border">{d.data!.history.map((h) => <div key={h.id} className="px-3 py-2 text-xs flex gap-2"><Badge>{h.action}</Badge><span className="font-medium">{h.actor}</span>{h.level > 0 && <span className="text-muted">level {h.level}</span>}<span className="text-muted flex-1 truncate">{h.comment}</span><span className="text-faint">{fmt.date(h.at)}</span></div>)}</div></Card>
    </div>}
  </Drawer>;
}

function Audit() {
  const [f, setF] = useState({ actor_type: "", entity_type: "", action: "" });
  const qs = new URLSearchParams({ limit: "200", ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) }).toString();
  const a = useApi<Array<R & { seq: number; details: R }>>(`audit?${qs}`);
  const [verify, setVerify] = useState<{ ok: boolean; checked: number; brokenAt?: number } | null>(null); const [vb, setVb] = useState(false);
  const [sel, setSel] = useState<R | null>(null); const { me } = useGlobal();
  if (!can(me, "audit.read")) return <Notice tone="warn">Your role does not include audit.read.</Notice>;
  return <div className="space-y-3">
    <Notice tone="info">Audit records are append-only (UPDATE/DELETE blocked by database triggers) and hash-chained: each record stores the previous record&apos;s hash.</Notice>
    <div className="flex flex-wrap items-center gap-2">
      <Select aria-label="Actor type" value={f.actor_type} onChange={(e) => setF({ ...f, actor_type: e.target.value })} options={[{ value: "", label: "All actors" }, "user", "agent", "system", "api"]} />
      <Input aria-label="Entity type" placeholder="Entity type (e.g. strategy)" value={f.entity_type} onChange={(e) => setF({ ...f, entity_type: e.target.value })} className="w-48" />
      <Input aria-label="Action prefix" placeholder="Action prefix (e.g. approval.)" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} className="w-52" />
      <div className="flex-1" />
      {verify && <Badge tone={verify.ok ? "ok" : "bad"}>{verify.ok ? <CheckCircle2 size={11} /> : <XCircle size={11} />}{verify.ok ? `chain intact · ${verify.checked} records` : `broken at seq ${verify.brokenAt}`}</Badge>}
      <Button size="sm" loading={vb} onClick={async () => { setVb(true); try { setVerify(await api("audit/verify")); } finally { setVb(false); } }}>Verify chain</Button>
    </div>
    <ErrorState error={a.error} onRetry={a.refresh} />
    {!a.data ? <Loading /> : <DataTable rows={a.data} onRow={setSel} exportName="audit-log" rowKey={(r) => String(r.seq)} cols={[
      { key: "seq", label: "#", align: "right" }, { key: "at", label: "When", render: (r) => fmt.date(r.at) }, { key: "actor_type", label: "Actor", render: (r) => <span><Badge tone={r.actor_type === "agent" ? "accent" : r.actor_type === "user" ? "info" : "neutral"}>{String(r.actor_type)}</Badge> {String(r.actor_id)}</span> },
      { key: "action", label: "Action", render: (r) => <code className="text-[11.5px]">{String(r.action)}</code> }, { key: "entity", label: "Entity", render: (r) => <span className="text-xs text-muted">{String(r.entity_type ?? "")}:{String(r.entity_id ?? "")}</span> },
      { key: "hash", label: "Hash", render: (r) => <code className="text-[10.5px] text-faint">{String(r.hash).slice(0, 10)}…</code> }]} />}
    <Drawer open={!!sel} onClose={() => setSel(null)} title={`Audit #${sel?.seq}`} width={560}>{sel && <div className="space-y-3"><KV items={[["Action", String(sel.action)], ["Actor", `${sel.actor_type}:${sel.actor_id}`], ["Entity", `${sel.entity_type}:${sel.entity_id}`], ["At", fmt.date(sel.at)], ["Hash", <code key="h" className="text-[10.5px] break-all">{String(sel.hash)}</code>], ["Previous hash", <code key="p" className="text-[10.5px] break-all">{String(sel.prev_hash)}</code>]]} /><JsonView value={sel.details} /></div>}</Drawer>
  </div>;
}

function Exclusions() {
  const x = useApi<R[]>("compliance/exclusions");
  return <div className="space-y-3"><ErrorState error={x.error} onRetry={x.refresh} />{!x.data ? <Loading /> : <DataTable rows={x.data} exportName="exclusions" search={(r) => `${r.player_id} ${r.exclusion_type}`} cols={[
    { key: "player_id", label: "Player", render: (r) => <a className="text-accent" href={`/audience/${r.player_id}`}>{String(r.player_id)}</a> }, { key: "display_name", label: "Name" },
    { key: "exclusion_type", label: "Type", render: (r) => <Badge tone={String(r.exclusion_type).includes("opt_out") ? "neutral" : "bad"}>{String(r.exclusion_type).replace(/_/g, " ")}</Badge> }, { key: "reason", label: "Reason" }, { key: "source", label: "Source" }, { key: "created_at", label: "Since", render: (r) => fmt.day(r.created_at) }]} />}</div>;
}

function Validation() {
  const filters = useApi<{ segments: Array<{ id: string; name: string }>; channels: Array<{ key: string; name: string }> }>("filters");
  const [f, setF] = useState({ segment_id: "", player_ids: "", purpose: "marketing", channel: "", action: "message", body: "" });
  const [res, setRes] = useState<{ total: number; allowed: number; by_policy: Record<string, number>; blocked_sample: Array<{ player_id: string; reasons: Array<{ policy: string; message: string }> }>; content: Array<{ policy: string; message: string }> } | null>(null);
  const [busy, setBusy] = useState(false); const { toast } = useGlobal();
  const run = async () => {
    setBusy(true);
    try { setRes(await api("compliance/validate", { body: { segment_id: f.segment_id || undefined, player_ids: f.player_ids ? f.player_ids.split(/[\s,]+/).filter(Boolean) : undefined, purpose: f.purpose, channel: f.channel || undefined, action: f.action, body: f.body || undefined } })); }
    catch (e) { toast({ kind: "error", title: "Validation failed", body: (e as Error).message }); }
    setBusy(false);
  };
  return <div className="grid lg:grid-cols-[380px_1fr] gap-3">
    <Card title="Compliance validator" actions={<Button size="sm" variant="primary" onClick={run} loading={busy}>Validate</Button>}>
      <div className="space-y-3">
        <Field label="Segment"><Select value={f.segment_id} onChange={(e) => setF({ ...f, segment_id: e.target.value })} options={[{ value: "", label: "— choose —" }, ...(filters.data?.segments ?? []).map((s) => ({ value: s.id, label: s.name }))]} /></Field>
        <Field label="…or player IDs" hint="Comma/space separated; overrides segment"><Input value={f.player_ids} onChange={(e) => setF({ ...f, player_ids: e.target.value })} placeholder="P100000, P100001" /></Field>
        <Field label="Purpose"><Select value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} options={["service", "security", "regulatory", "protective", "operational", "membership", "marketing", "regulated_promotion"]} /></Field>
        <Field label="Channel"><Select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })} options={[{ value: "", label: "— none —" }, ...(filters.data?.channels ?? []).map((c) => ({ value: c.key, label: c.name }))]} /></Field>
        <Field label="Action"><Select value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} options={["message", "offer", "targeting"]} /></Field>
        <Field label="Message body (optional)" hint="Checked for prohibited phrases & RG notice"><Textarea rows={3} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
      </div>
    </Card>
    <Card title="Result">{!res ? <div className="text-xs text-muted">Run a validation to see which mandatory policies would block which players. Nothing is sent.</div> : <div className="space-y-3">
      <div className="flex gap-3 text-[13px]"><Badge tone="ok">{res.allowed} allowed</Badge><Badge tone="bad">{res.total - res.allowed} blocked</Badge><span className="text-muted">of {res.total}</span></div>
      {Object.keys(res.by_policy).length > 0 && <div className="flex flex-wrap gap-1.5">{Object.entries(res.by_policy).map(([k, v]) => <Badge key={k} tone="warn">{k}: {v}</Badge>)}</div>}
      {res.content.length > 0 && <Notice tone="bad">Content issues: {res.content.map((c) => c.message).join("; ")}</Notice>}
      <DataTable dense rows={res.blocked_sample as unknown as R[]} rowKey={(r) => String(r.player_id)} cols={[{ key: "player_id", label: "Player" }, { key: "reasons", label: "Reasons", render: (r) => <div className="flex flex-wrap gap-1">{(r.reasons as Array<{ policy: string; message: string }>).map((x) => <Badge key={x.policy} title={x.message} tone="bad">{x.policy}</Badge>)}</div> }]} />
    </div>}</Card>
  </div>;
}

function Checks() {
  const c = useApi<R[]>("compliance/checks");
  return <div><ErrorState error={c.error} onRetry={c.refresh} />{!c.data ? <Loading /> : <DataTable rows={c.data} exportName="compliance-checks" cols={[
    { key: "at", label: "When", render: (r) => fmt.date(r.at) }, { key: "context", label: "Context", render: (r) => <code className="text-[11px]">{String(r.context)}</code> }, { key: "ref_id", label: "Reference", render: (r) => <span className="text-xs text-muted">{String(r.ref_id ?? "–")}</span> },
    { key: "player_id", label: "Player", render: (r) => String(r.player_id ?? "(batch)") }, { key: "purpose", label: "Purpose" }, { key: "channel", label: "Channel", render: (r) => String(r.channel ?? "–") },
    { key: "allowed", label: "Result", render: (r) => <Badge tone={r.allowed ? "ok" : "bad"}>{r.allowed ? "allowed" : "blocked"}</Badge> }, { key: "reasons", label: "Details", render: (r) => <code className="text-[10.5px] text-muted">{String(r.reasons).slice(0, 90)}</code> }]} />}</div>;
}

function RgPanel() {
  return <div className="grid md:grid-cols-2 gap-3">
    <Card title="Enforced when a restriction or self-exclusion is received">
      <ol className="list-decimal pl-5 space-y-1 text-[12.5px]">
        <li>Customer 360° flags updated (self_excluded / rg_restricted) with attribute history</li><li>Active exclusion record created</li><li>Mandatory compliance tag <code>rg_excluded</code> applied</li>
        <li>Removed from all promotional segments (and promotional segments always exclude them on refresh)</li><li>Promotional journey executions stopped immediately (overrides version pinning)</li>
        <li>Queued promotional messages cancelled</li><li>Unclaimed entitlements cancelled; no new incentives can be issued</li><li>Protective service task created (per active RG strategy)</li><li>Every step recorded in the append-only audit log</li>
      </ol>
    </Card>
    <Card title="Communications policy for protected players">
      <div className="space-y-2 text-[12.5px]">
        <div><Badge tone="ok">allowed</Badge> Service, security, regulatory and protective communications where channel consent exists</div>
        <div><Badge tone="bad">blocked</Badge> Marketing, membership promotions, regulated promotions, gambling incentives of any category</div>
        <Notice tone="warn">Losses, chasing behavior, financial distress, prolonged play or vulnerability signals are never used to increase incentives or target engagement. Restricted gaming transaction data is available only to accounting, fraud, compliance and responsible-gaming roles.</Notice>
        <div className="text-xs text-muted">To apply a restriction manually, open a player in Audience → Customer 360°. Scenario E in Opportunity Finder demonstrates the end-to-end flow.</div>
      </div>
    </Card>
  </div>;
}

export default function Page() { return <Suspense><Inner /></Suspense>; }
