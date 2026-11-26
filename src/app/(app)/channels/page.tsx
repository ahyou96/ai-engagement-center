"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Plug, Pencil, Sparkles, Send, Plus, RefreshCw } from "lucide-react";
import { api, ApiError, useApi, useGlobal, useStream, fmt, can } from "@/components/hooks";
import { Badge, Button, Card, DataTable, Drawer, ErrorState, Field, Input, KV, Loading, Modal, Notice, PageHeader, Select, Status, Tabs, Textarea, Toggle, cx } from "@/components/ui";
import { Chart, bar } from "@/components/chart";
import type { EChartsOption } from "echarts";

type Stats = { channel: string; total: number; delivered: number; read: number; clicked: number; failed: number; cost: number } | null;
type Channel = { key: string; name: string; provider: string; mode: string; connection_status: string; cost_per_message: number; retry_policy: Record<string, unknown>; fallback_channels: string[]; consent_channel: string; restrictions: string | null; health: string; enabled: number; config: Record<string, number>; stats_7d: Stats; stats_24h: Stats; errors: Array<{ error_code: string; n: number }> };
type Template = { id: string; name: string; channel: string; language: string; purpose: string; subject: string | null; body: string; variables: string[]; status: string; provider_approval: string; version: number; ai_drafted: number; compliance_result: { passed: boolean; issues: Array<{ policy: string; message: string }> } | null; updated_at: string };

const rate = (s: Stats, k: "delivered" | "read" | "clicked") => (!s || !s.total ? null : k === "delivered" ? s.delivered / s.total : s[k] / Math.max(1, s.delivered));

function Inner() {
  const sp = useSearchParams(); const router = useRouter(); const { t } = useGlobal();
  const tab = sp.get("tab") ?? "channels";
  const setTab = (k: string) => { const p = new URLSearchParams(sp.toString()); p.set("tab", k); router.replace(`/channels?${p.toString()}`); };
  return (
    <div className="space-y-4">
      <PageHeader title={t("channels")} subtitle="Unified channel center behind a provider-adapter interface. All channels run on mock adapters — no real messages are sent." />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: "channels", label: "Channels" }, { key: "templates", label: t("templates") }, { key: "delivery", label: t("delivery") }, { key: "routing", label: "Routing strategy" }]} />
      {tab === "channels" && <ChannelsTab focus={sp.get("channel")} />}
      {tab === "templates" && <TemplatesTab />}
      {tab === "delivery" && <DeliveryTab initialChannel={sp.get("channel") ?? ""} />}
      {tab === "routing" && <RoutingTab />}
    </div>
  );
}
export default function Page() { return <Suspense><Inner /></Suspense>; }

function ChannelsTab({ focus }: { focus: string | null }) {
  const { toast, me } = useGlobal();
  const ch = useApi<Channel[]>("channels");
  const [edit, setEdit] = useState<Channel | null>(null);
  const [test, setTest] = useState<{ key: string; result: string } | null>(null);
  useEffect(() => { if (focus && ch.data) { const el = document.getElementById(`ch-${focus}`); el?.scrollIntoView({ behavior: "smooth", block: "center" }); } }, [focus, ch.data]);
  if (ch.error) return <ErrorState error={ch.error} onRetry={ch.refresh} />;
  if (!ch.data) return <Loading rows={6} />;
  const writable = can(me, "channels.write");
  return (
    <>
      <Notice tone="warn">Every channel below uses a <b>mock adapter</b>: delivery receipts are simulated deterministically. A channel is only “connected” after a real provider integration is configured server-side and verified (see docs/INTEGRATIONS.md).</Notice>
      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
        {ch.data.map((c) => (
          <section key={c.key} id={`ch-${c.key}`} className={cx("rounded-lg border bg-panel p-3.5 space-y-2.5", focus === c.key ? "border-accent ring-2 ring-[var(--ring)]" : "border-border", !c.enabled && "opacity-60")}>
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0"><div className="font-semibold text-[14px]">{c.name}</div><div className="text-xs text-muted truncate">{c.provider}</div></div>
              <Status value={c.health} />
            </div>
            <div className="flex flex-wrap gap-1"><Badge tone="warn">mock</Badge><Badge tone="info">{c.connection_status.replace(/_/g, " ")}</Badge>{!c.enabled && <Badge tone="bad">disabled</Badge>}<Badge>consent: {c.consent_channel}</Badge></div>
            <div className="text-[11px] text-faint">Not connected to a real provider</div>
            <div className="grid grid-cols-4 gap-2 text-center">
              {[["24h deliv.", fmt.pct(rate(c.stats_24h, "delivered"))], ["7d deliv.", fmt.pct(rate(c.stats_7d, "delivered"))], ["7d read", fmt.pct(rate(c.stats_7d, "read"))], ["7d click", fmt.pct(rate(c.stats_7d, "clicked"))]].map(([l, v]) => (
                <div key={l} className="rounded-md bg-panel-2 py-1.5"><div className={cx("text-[13px] font-semibold tabular-nums", l === "24h deliv." && (rate(c.stats_24h, "delivered") ?? 1) < 0.9 && "text-bad")}>{v}</div><div className="text-[10.5px] text-faint">{l}</div></div>
              ))}
            </div>
            <KV items={[["Cost / msg", fmt.money(c.cost_per_message)], ["Sent (7d)", fmt.int(c.stats_7d?.total)], ["Fallbacks", c.fallback_channels.length ? c.fallback_channels.join(" → ") : "none"], ["Retry", `${c.retry_policy.max_attempts ?? "–"} attempts`], ["Restrictions", c.restrictions ?? "–"]]} />
            {c.errors.length > 0 && <div><div className="text-[11px] text-muted mb-1">Top error codes (7d)</div><div className="flex flex-wrap gap-1">{c.errors.map((e) => <Badge key={e.error_code} tone="bad">{e.error_code} · {e.n}</Badge>)}</div></div>}
            <div className="flex gap-2 pt-1">
              <Button size="sm" onClick={async () => { try { const r = await api<{ result: string }>(`channels/${c.key}/test`, { body: {} }); setTest({ key: c.name, result: r.result }); } catch (e) { toast({ kind: "error", title: (e as Error).message }); } }} disabled={!writable}><Plug size={13} />Test connection</Button>
              {writable && <Button size="sm" variant="ghost" onClick={() => setEdit(c)}><Pencil size={13} />Edit</Button>}
              <Link href={`/channels?tab=delivery&channel=${c.key}`} className="ml-auto text-xs text-accent self-center">Delivery →</Link>
            </div>
          </section>
        ))}
      </div>
      <Modal open={!!test} onClose={() => setTest(null)} title={`Connection test: ${test?.key}`}><Notice tone="warn">{test?.result}</Notice></Modal>
      {edit && <ChannelEdit c={edit} all={ch.data} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); ch.refresh(); }} />}
    </>
  );
}

function ChannelEdit({ c, all, onClose, onSaved }: { c: Channel; all: Channel[]; onClose: () => void; onSaved: () => void }) {
  const { toast } = useGlobal();
  const [enabled, setEnabled] = useState(!!c.enabled); const [cost, setCost] = useState(String(c.cost_per_message));
  const [fallbacks, setFallbacks] = useState<string[]>(c.fallback_channels); const [attempts, setAttempts] = useState(String(c.retry_policy.max_attempts ?? 3));
  const [busy, setBusy] = useState(false); const [liveErr, setLiveErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    try { await api(`channels/${c.key}`, { method: "PUT", body: { enabled, cost_per_message: Number(cost), fallback_channels: fallbacks, retry_policy: { ...c.retry_policy, max_attempts: Number(attempts) } } }); toast({ kind: "success", title: `${c.name} updated` }); onSaved(); }
    catch (e) { toast({ kind: "error", title: "Update failed", body: (e as Error).message }); }
    setBusy(false);
  };
  const tryLive = async () => { try { await api(`channels/${c.key}`, { method: "PUT", body: { mode: "live" } }); } catch (e) { setLiveErr((e as ApiError).message); } };
  return (
    <Drawer open onClose={onClose} title={`Edit ${c.name}`} width={460} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="space-y-4">
        <label className="flex items-center gap-2 text-[13px]"><Toggle checked={enabled} onChange={setEnabled} label="Enabled" />Channel enabled</label>
        <Field label="Cost per message (PHP)"><Input type="number" step="0.001" value={cost} onChange={(e) => setCost(e.target.value)} /></Field>
        <Field label="Retry attempts"><Input type="number" min={1} max={10} value={attempts} onChange={(e) => setAttempts(e.target.value)} /></Field>
        <Field label="Approved fallback channels (in order)" hint="Fallback still requires the player's consent on the fallback channel.">
          <div className="flex flex-wrap gap-1.5">{all.filter((x) => x.key !== c.key).map((x) => { const on = fallbacks.includes(x.key); return (
            <button key={x.key} type="button" onClick={() => setFallbacks(on ? fallbacks.filter((f) => f !== x.key) : [...fallbacks, x.key])} className={cx("text-xs rounded-full border px-2.5 py-1", on ? "border-accent bg-accent-soft text-accent" : "border-border text-muted")}>{on && `${fallbacks.indexOf(x.key) + 1}. `}{x.name}</button>); })}</div>
        </Field>
        <div className="rounded-md border border-border p-3 space-y-2">
          <div className="text-[12.5px] font-medium">Live mode</div>
          <div className="text-xs text-muted">Credentials are configured server-side only (environment / secret manager) and never sent to the browser.</div>
          <Button size="sm" onClick={tryLive}>Switch to live…</Button>
          {liveErr && <Notice tone="bad">{liveErr}</Notice>}
        </div>
      </div>
    </Drawer>
  );
}

const PURPOSES = ["service", "security", "operational", "protective", "membership", "marketing"];
function TemplatesTab() {
  const { toast, me } = useGlobal();
  const tpl = useApi<Template[]>("templates"); const chans = useApi<Channel[]>("channels");
  const [editing, setEditing] = useState<Partial<Template> | null>(null);
  const [submitRes, setSubmitRes] = useState<{ passed: boolean; issues?: Array<{ policy: string; message: string }>; approvalId?: string } | null>(null);
  if (tpl.error) return <ErrorState error={tpl.error} onRetry={tpl.refresh} />;
  if (!tpl.data) return <Loading rows={6} />;
  const writable = can(me, "templates.write");
  const submit = async (id: string) => { try { const r = await api<{ passed: boolean; issues?: Array<{ policy: string; message: string }>; approvalId?: string }>(`templates/${id}/submit`, { body: {} }); setSubmitRes(r); tpl.refresh(); } catch (e) { toast({ kind: "error", title: "Submit failed", body: (e as Error).message }); } };
  return (
    <>
      <Card title="Template catalog" subtitle="Channel-specific, multilingual, versioned templates. Only approved templates can be used by campaigns and journeys." actions={writable && <Button size="sm" variant="primary" onClick={() => setEditing({ channel: "inbox", language: "en", purpose: "service", body: "" })}><Plus size={13} />New template</Button>} pad={false}>
        <div className="p-3"><DataTable rows={tpl.data as unknown as Record<string, unknown>[]} exportName="templates" search={(r) => `${r.name} ${r.channel} ${r.purpose} ${r.body}`} onRow={(r) => setEditing(r as unknown as Template)} cols={[
          { key: "name", label: "Template", render: (r) => <div className="max-w-[320px]"><div className="font-medium truncate">{String(r.name)}</div><div className="text-xs text-muted truncate">{String(r.body)}</div></div> },
          { key: "channel", label: "Channel" }, { key: "language", label: "Lang" },
          { key: "purpose", label: "Purpose", render: (r) => <Badge tone={["membership", "marketing"].includes(String(r.purpose)) ? "warn" : "info"}>{String(r.purpose)}</Badge> },
          { key: "status", label: "Status", render: (r) => <Status value={String(r.status)} /> },
          { key: "provider_approval", label: "Provider", render: (r) => <span className="text-xs">{String(r.provider_approval).replace(/_/g, " ")}</span> },
          { key: "version", label: "Ver.", render: (r) => `v${r.version}` },
          { key: "compliance", label: "Compliance", render: (r) => { const c = r.compliance_result as Template["compliance_result"]; return c ? (c.passed ? <Badge tone="ok">passed</Badge> : <Badge tone="bad" title={c.issues.map((i) => i.message).join("; ")}>{c.issues.length} issue(s)</Badge>) : "–"; } },
          { key: "ai", label: "", render: (r) => (r.ai_drafted ? <Badge tone="accent"><Sparkles size={10} />AI</Badge> : null) },
          { key: "act", label: "", render: (r) => writable && ["draft", "changes_required", "rejected"].includes(String(r.status)) ? <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); submit(String(r.id)); }}><Send size={12} />Submit</Button> : null },
        ]} /></div>
      </Card>
      {editing && <TemplateEditor tpl={editing} channels={chans.data ?? []} writable={writable} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); tpl.refresh(); }} onSubmit={submit} />}
      <Modal open={!!submitRes} onClose={() => setSubmitRes(null)} title="Submission result">
        {submitRes?.passed ? <Notice tone="ok">Compliance validation passed. Approval request <b>{submitRes.approvalId}</b> created — <Link className="underline" href={`/compliance?tab=approvals&id=${submitRes.approvalId}`}>open in Approval Center</Link>.</Notice>
          : <div className="space-y-2"><Notice tone="bad">Compliance validation failed — fix and resubmit.</Notice>{submitRes?.issues?.map((i, k) => <div key={k} className="text-[12.5px]"><Badge tone="bad">{i.policy}</Badge> {i.message}</div>)}</div>}
      </Modal>
    </>
  );
}

function TemplateEditor({ tpl, channels, writable, onClose, onSaved, onSubmit }: { tpl: Partial<Template>; channels: Channel[]; writable: boolean; onClose: () => void; onSaved: () => void; onSubmit: (id: string) => void }) {
  const { toast } = useGlobal();
  const isNew = !tpl.id;
  const [f, setF] = useState({ name: tpl.name ?? "", channel: tpl.channel ?? "inbox", language: tpl.language ?? "en", purpose: tpl.purpose ?? "service", subject: tpl.subject ?? "", body: tpl.body ?? "" });
  const [topic, setTopic] = useState(""); const [draftNote, setDraftNote] = useState<{ note: string; generated_by: string; issues: Array<{ policy: string; message: string }> } | null>(null);
  const [aiDrafted, setAiDrafted] = useState(false); const [busy, setBusy] = useState(false);
  const vars = useMemo(() => [...new Set((f.body.match(/\{\{\s*(\w+)\s*\}\}/g) ?? []).map((x) => x.replace(/[{}\s]/g, "")))], [f.body]);
  const preview = f.body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (k === "first_name" ? "Andrea" : k === "player_id" ? "P100123" : `[${k}]`));
  const draft = async () => {
    try { const r = await api<{ body: string; issues: Array<{ policy: string; message: string }>; note: string; generated_by: string }>("templates/draft", { body: { purpose: f.purpose, channel: f.channel, topic } }); setF({ ...f, body: r.body }); setDraftNote(r); setAiDrafted(true); }
    catch (e) { toast({ kind: "error", title: (e as Error).message }); }
  };
  const save = async () => {
    setBusy(true);
    try {
      if (isNew) await api("templates", { body: { ...f, subject: f.subject || undefined, ai_drafted: aiDrafted } });
      else await api(`templates/${tpl.id}`, { method: "PUT", body: { body: f.body, subject: f.subject || undefined } });
      toast({ kind: "success", title: isNew ? "Template created (draft)" : "New template version saved (draft — resubmit for approval)" }); onSaved();
    } catch (e) { toast({ kind: "error", title: "Save failed", body: (e as Error).message }); }
    setBusy(false);
  };
  const limit = f.channel === "sms" ? 160 : f.channel === "app_push" || f.channel === "web_push" ? 120 : null;
  return (
    <Modal open onClose={onClose} width={760} title={isNew ? "New template" : `${tpl.name} · v${tpl.version}`}
      footer={<>{!isNew && writable && <Button onClick={() => onSubmit(String(tpl.id))}><Send size={13} />Submit for approval</Button>}<Button onClick={onClose}>Close</Button>{writable && <Button variant="primary" loading={busy} onClick={save} disabled={f.body.length < 5 || (isNew && f.name.length < 3)}>Save</Button>}</>}>
      <div className="grid md:grid-cols-2 gap-4">
        <div className="space-y-3">
          <Field label="Name"><Input value={f.name} disabled={!isNew} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Channel"><Select value={f.channel} disabled={!isNew} onChange={(e) => setF({ ...f, channel: e.target.value })} options={channels.length ? channels.map((c) => ({ value: c.key, label: c.name })) : [f.channel]} /></Field>
            <Field label="Language"><Select value={f.language} disabled={!isNew} onChange={(e) => setF({ ...f, language: e.target.value })} options={["en", "fil", "zh"]} /></Field>
            <Field label="Purpose"><Select value={f.purpose} disabled={!isNew} onChange={(e) => setF({ ...f, purpose: e.target.value })} options={PURPOSES} /></Field>
          </div>
          {f.channel === "email" && <Field label="Subject"><Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>}
          <Field label="Body" hint={`Variables: {{first_name}}, {{player_id}}${limit ? ` · ${f.body.length}/${limit} chars recommended` : ""}`}><Textarea rows={6} value={f.body} disabled={!writable} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
          {writable && <div className="rounded-md border border-border p-2.5 space-y-2">
            <div className="text-xs font-medium flex items-center gap-1"><Sparkles size={12} className="text-accent" />AI-assisted drafting</div>
            <div className="flex gap-2"><Input className="flex-1" placeholder="Topic, e.g. our verification team needs a clearer ID photo" value={topic} onChange={(e) => setTopic(e.target.value)} /><Button size="sm" onClick={draft} disabled={topic.length < 3}>Draft</Button></div>
            {draftNote && <div className="text-[11.5px] text-muted">{draftNote.note} <span className="text-faint">({draftNote.generated_by})</span></div>}
          </div>}
        </div>
        <div className="space-y-3">
          <div className="text-xs text-muted font-medium">Preview</div>
          <div className="rounded-lg border border-border bg-panel-2 p-3 text-[13px] whitespace-pre-wrap min-h-24">{f.channel === "email" && f.subject && <div className="font-semibold mb-1">{f.subject}</div>}{preview || <span className="text-faint">Empty</span>}</div>
          <div className="text-xs"><span className="text-muted">Variables:</span> {vars.length ? vars.map((v) => <code key={v} className="font-mono mr-1">{v}</code>) : "none"}</div>
          {(draftNote?.issues ?? tpl.compliance_result?.issues ?? []).length > 0 && <div className="space-y-1">{(draftNote?.issues ?? tpl.compliance_result?.issues ?? []).map((i, k) => <Notice key={k} tone="bad">{i.policy}: {i.message}</Notice>)}</div>}
          {!isNew && <KV items={[["Status", <Status key="s" value={tpl.status} />], ["Provider approval", String(tpl.provider_approval ?? "–").replace(/_/g, " ")], ["Updated", fmt.date(tpl.updated_at)]]} />}
          <Notice tone="info">Promotional templates require a responsible-gaming / opt-out notice; service templates may not contain incentive language. Edits create a new version that must be re-approved.</Notice>
        </div>
      </div>
    </Modal>
  );
}

const FUNNEL = ["queued", "sent", "delivered", "read", "clicked", "failed", "rejected", "unsubscribed", "cancelled"];
function DeliveryTab({ initialChannel }: { initialChannel: string }) {
  const [f, setF] = useState({ channel: initialChannel, status: "", purpose: "" });
  const qs = useMemo(() => { const p = new URLSearchParams({ limit: "200" }); for (const [k, v] of Object.entries(f)) if (v) p.set(k, v); return p.toString(); }, [f]);
  const m = useApi<{ rows: Array<Record<string, unknown>>; funnel: Array<{ status: string; n: number }> }>(`messages?${qs}`);
  const chans = useApi<Channel[]>("channels");
  const [live, setLive] = useState(0);
  useStream("stream?topics=delivery", () => { setLive((x) => x + 1); });
  useEffect(() => { if (live) { const t = setTimeout(() => m.refresh(), 1500); return () => clearTimeout(t); } }, [live]); // eslint-disable-line react-hooks/exhaustive-deps
  const funnel = FUNNEL.map((s) => m.data?.funnel.find((x) => x.status === s)?.n ?? 0);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <Select aria-label="Channel" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })} options={[{ value: "", label: "All channels" }, ...(chans.data ?? []).map((c) => ({ value: c.key, label: c.name }))]} />
        <Select aria-label="Status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} options={[{ value: "", label: "All statuses" }, ...FUNNEL]} />
        <Select aria-label="Purpose" value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} options={[{ value: "", label: "All purposes" }, ...PURPOSES]} />
        <Button size="sm" variant="ghost" onClick={m.refresh}><RefreshCw size={13} /></Button>
        <span className="text-[11px] text-faint ml-auto">{live} live delivery updates · mock provider receipts</span>
      </div>
      <ErrorState error={m.error} onRetry={m.refresh} />
      <Card title="Delivery funnel" subtitle="Delivery-event counts for the filtered messages (simulated receipts)">
        {m.data ? <Chart height={230} option={bar(FUNNEL, [{ name: "Events", data: funnel }])} /> : <Loading rows={3} />}
      </Card>
      <Card title="Recent messages" pad={false}><div className="p-3">
        {m.data ? <DataTable rows={m.data.rows} exportName="messages" search={(r) => `${r.player_id} ${r.channel} ${r.status} ${r.error_code ?? ""}`} cols={[
          { key: "created_at", label: "Created", render: (r) => fmt.date(r.created_at) },
          { key: "player_id", label: "Player", render: (r) => <Link className="text-accent" href={`/audience/${r.player_id}`}>{String(r.player_id)}</Link> },
          { key: "channel", label: "Channel" }, { key: "purpose", label: "Purpose" },
          { key: "status", label: "Status", render: (r) => <Status value={String(r.status)} /> },
          { key: "error_code", label: "Error", render: (r) => (r.error_code ? <Badge tone="bad">{String(r.error_code)}</Badge> : "–") },
          { key: "cost", label: "Cost", align: "right", render: (r) => fmt.money(r.cost) },
          { key: "src", label: "Source", render: (r) => <span className="text-xs text-muted">{r.campaign_id ? `campaign ${r.campaign_id}` : r.journey_id ? `journey ${r.journey_id}` : r.run_id ? `workflow ${r.run_id}` : "transactional"}{r.variant ? ` · ${r.variant}` : ""}</span> },
        ]} /> : <Loading />}
      </div></Card>
    </div>
  );
}

function RoutingTab() {
  const s = useApi<{ strategies: Array<{ id: string; category: string; name: string; active_version: number }> }>("strategies");
  const sid = s.data?.strategies.find((x) => x.category === "channel_routing")?.id;
  const d = useApi<{ strategy: Record<string, unknown>; versions: Array<{ version: number; status: string; config: Record<string, unknown>; change_summary: string; created_at: string }> }>(sid ? `strategies/${sid}` : null);
  const ch = useApi<Channel[]>("channels");
  const active = d.data?.versions.find((v) => v.status === "active");
  const cfg = active?.config as { primary?: string; fallbacks?: string[]; min_delivery_rate?: number; max_cost_per_message?: number; evaluation_window_hours?: number } | undefined;
  const chartOpt: EChartsOption | null = ch.data ? {
    tooltip: { trigger: "axis" }, legend: {},
    xAxis: { type: "category", data: ch.data.map((c) => c.name) },
    yAxis: [{ type: "value", name: "Delivery %", max: 100 }, { type: "value", name: "₱/msg", splitLine: { show: false } }],
    series: [{ name: "7d delivery %", type: "bar", barMaxWidth: 26, data: ch.data.map((c) => Math.round((rate(c.stats_7d, "delivered") ?? 0) * 1000) / 10) }, { name: "Cost / msg", type: "line", yAxisIndex: 1, data: ch.data.map((c) => c.cost_per_message) }],
  } : null;
  if (s.error || d.error) return <ErrorState error={s.error ?? d.error} />;
  return (
    <div className="grid lg:grid-cols-3 gap-3">
      <Card title="Active routing strategy" subtitle={active ? `v${active.version} · ${active.change_summary}` : undefined} actions={<Link href={sid ? `/optimizer?strategy=${sid}` : "/optimizer"} className="text-xs text-accent">Open in Optimizer →</Link>}>
        {!cfg ? <Loading rows={4} /> : <div className="space-y-3">
          <KV items={[["Primary channel", <Badge key="p" tone="accent">{cfg.primary}</Badge>], ["Fallbacks", (cfg.fallbacks ?? []).join(" → ") || "none"], ["Min delivery rate", fmt.pct(cfg.min_delivery_rate, 0)], ["Max cost / msg", fmt.money(cfg.max_cost_per_message)], ["Evaluation window", `${cfg.evaluation_window_hours ?? "–"}h`]]} />
          <Notice tone="info">New executions read the latest approved, active version from the Strategy Registry and pin it. Fallback sends still require consent on the fallback channel.</Notice>
        </div>}
      </Card>
      <Card title="Cost vs delivery by channel" className="lg:col-span-2">{chartOpt ? <Chart height={280} option={chartOpt} /> : <Loading rows={4} />}</Card>
      <Card title="Routing version history" className="lg:col-span-3" pad={false}><div className="p-3">
        <DataTable rows={(d.data?.versions ?? []) as unknown as Record<string, unknown>[]} rowKey={(r) => `v${r.version}`} cols={[
          { key: "version", label: "Version", render: (r) => `v${r.version}` }, { key: "status", label: "Status", render: (r) => <Status value={String(r.status)} /> },
          { key: "cfg", label: "Primary → fallbacks", render: (r) => { const c = r.config as { primary?: string; fallbacks?: string[] }; return `${c.primary} → ${(c.fallbacks ?? []).join(", ") || "—"}`; } },
          { key: "change_summary", label: "Change" }, { key: "created_at", label: "Created", render: (r) => fmt.day(r.created_at) },
        ]} />
      </div></Card>
    </div>
  );
}
