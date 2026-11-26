"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, RefreshCw, ArrowUp, ArrowDown, X } from "lucide-react";
import { api, ApiError, can, fmt, useApi, useGlobal } from "@/components/hooks";
import { Badge, Button, Card, Confirm, DataTable, Drawer, Empty, ErrorState, Field, Input, KV, Loading, Notice, PageHeader, Select, Stat, Status, Toggle, cx } from "@/components/ui";
import { Chart, bar } from "@/components/chart";

type Campaign = { id: string; name: string; objective: string; purpose: string; status: string; segment_id: string | null; segment_name: string | null; member_count: number | null; channels: string[]; template_id: string | null; schedule_at: string | null; timezone: string; budget: number; ab_test: { variant_b_template_id: string; split: number } | null; approval_id: string | null; version: number; strategy_version: number | null; stats: Record<string, unknown>; created_by: string; updated_at: string };
type Meta = { objectives: Record<string, { purpose: string; label: string }>; segments: Array<{ id: string; name: string; purpose: string; member_count: number }>; templates: Array<{ id: string; name: string; channel: string; purpose: string; status: string; body: string }>; channels: Array<{ key: string; name: string; cost_per_message: number; health: string }> };
type Validation = { audience: number; perChannel: Record<string, { allowed: number; blocked: number; by_policy: Record<string, number>; est_cost: number }>; estCost: number; issues: Array<{ level: string; message: string }>; ok: boolean };

const PURPOSE_TONE: Record<string, string> = { service: "info", security: "info", operational: "neutral", membership: "accent", marketing: "warn" };
const PROMO = (p: string) => p === "membership" || p === "marketing";

function useErr() {
  const { toast } = useGlobal();
  return (e: unknown, title = "Action failed") => {
    const err = e as ApiError;
    const d = Array.isArray(err.details) ? (err.details as Array<{ message?: string }>).map((x) => x.message ?? JSON.stringify(x)).join("; ") : undefined;
    toast({ kind: "error", title: `${title}: ${err.message}`, body: d });
  };
}

function ValidationView({ v }: { v: Validation }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[12.5px]"><Badge tone={v.ok ? "ok" : "bad"}>{v.ok ? "validation passed" : "validation failed"}</Badge><span className="text-muted">Audience {fmt.int(v.audience)} · est. cost {fmt.money(v.estCost)}</span></div>
      {v.issues.map((i, k) => <Notice key={k} tone={i.level === "error" ? "bad" : "warn"}>{i.message}</Notice>)}
      <DataTable dense rows={Object.entries(v.perChannel).map(([ch, x]) => ({ channel: ch, ...x }))} rowKey={(r) => String(r.channel)} cols={[
        { key: "channel", label: "Channel" }, { key: "allowed", label: "Reachable", align: "right", render: (r) => fmt.int(r.allowed) }, { key: "blocked", label: "Blocked", align: "right", render: (r) => fmt.int(r.blocked) },
        { key: "by_policy", label: "Blocked by policy (consent, frequency, quiet hours, exclusions…)", render: (r) => <div className="flex flex-wrap gap-1">{Object.entries(r.by_policy as Record<string, number>).map(([k, n]) => <Badge key={k} tone="warn">{k}: {n}</Badge>)}{!Object.keys(r.by_policy as object).length && <span className="text-faint">none</span>}</div> },
        { key: "est_cost", label: "Est. cost", align: "right", render: (r) => fmt.money(r.est_cost) },
      ]} />
    </div>
  );
}

function CampaignsInner() {
  const sp = useSearchParams(); const router = useRouter(); const { t } = useGlobal();
  const list = useApi<Campaign[]>("campaigns");
  const [status, setStatus] = useState(""); const [purpose, setPurpose] = useState("");
  const [sel, setSel] = useState<string | null>(sp.get("id"));
  const [wizard, setWizard] = useState(sp.get("new") === "1");
  const rows = (list.data ?? []).filter((c) => (!status || c.status === status) && (!purpose || c.purpose === purpose));
  const counts = useMemo(() => { const m: Record<string, number> = {}; for (const c of list.data ?? []) m[c.status] = (m[c.status] ?? 0) + 1; return m; }, [list.data]);
  const closeWizard = () => { setWizard(false); if (sp.get("new")) router.replace("/campaigns"); };
  return (
    <div className="space-y-4">
      <PageHeader title={t("campaigns")} subtitle="Purpose-classified campaigns with consent, frequency, quiet-hours and budget validation, approval workflow and mock sending"
        actions={<><Button size="sm" variant="ghost" onClick={list.refresh}><RefreshCw size={13} /></Button><Button variant="primary" onClick={() => setWizard(true)}><Plus size={13} />New campaign</Button></>} />
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        {["draft", "pending_approval", "approved", "completed", "paused"].map((s) => <Stat key={s} label={s.replace("_", " ")} value={counts[s] ?? 0} format={fmt.int} onClick={() => setStatus(status === s ? "" : s)} />)}
      </div>
      <ErrorState error={list.error} onRetry={list.refresh} />
      <Card title="Campaigns" actions={<><Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: "", label: "All statuses" }, "draft", "pending_approval", "approved", "completed", "paused", "cancelled", "rejected", "changes_requested"]} /><Select aria-label="Purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} options={[{ value: "", label: "All purposes" }, "service", "security", "operational", "membership", "marketing"]} /></>} pad={false}>
        <div className="p-3">{list.loading && !list.data ? <Loading /> : <DataTable rows={rows as unknown as Record<string, unknown>[]} exportName="campaigns" search={(r) => `${r.name} ${r.segment_name}`} onRow={(r) => setSel(String(r.id))} cols={[
          { key: "name", label: "Campaign", render: (r) => <span className="font-medium">{String(r.name)}</span> },
          { key: "purpose", label: "Purpose", render: (r) => <Badge tone={PURPOSE_TONE[String(r.purpose)]}>{String(r.purpose)}</Badge> },
          { key: "status", label: "Status", render: (r) => <Status value={String(r.status)} /> },
          { key: "segment_name", label: "Audience", render: (r) => <span>{String(r.segment_name ?? "–")} <span className="text-faint">{fmt.int(r.member_count)}</span></span> },
          { key: "channels", label: "Channels", render: (r) => (r.channels as string[]).join(" → ") },
          { key: "ab", label: "A/B", render: (r) => (r.ab_test ? <Badge tone="accent">A/B</Badge> : null) },
          { key: "version", label: "Ver", render: (r) => `v${r.version}` },
          { key: "sent", label: "Sent", align: "right", sort: (r) => Number((r.stats as Record<string, unknown>).sent ?? 0), render: (r) => fmt.int((r.stats as Record<string, unknown>).sent) },
          { key: "cost", label: "Cost", align: "right", render: (r) => fmt.money((r.stats as Record<string, unknown>).cost) },
          { key: "updated_at", label: "Updated", render: (r) => fmt.ago(r.updated_at) },
        ]} />}</div>
      </Card>
      <CampaignDrawer id={sel} onClose={() => { setSel(null); if (sp.get("id")) router.replace("/campaigns"); }} onChanged={list.refresh} onOpen={setSel} />
      {wizard && <Wizard onClose={closeWizard} onDone={(id) => { closeWizard(); list.refresh(); setSel(id); }} initial={{ segment: sp.get("segment") ?? "", template: sp.get("template") ?? "", name: sp.get("name") ?? "" }} />}
    </div>
  );
}

function CampaignDrawer({ id, onClose, onChanged, onOpen }: { id: string | null; onClose: () => void; onChanged: () => void; onOpen: (id: string) => void }) {
  const d = useApi<{ campaign: Campaign; byStatus: Array<{ status: string; n: number }>; byVariant: Array<{ variant: string | null; sent: number; delivered: number; read: number; clicked: number }>; byChannel: Array<{ channel: string; n: number; cost: number }>; versions: Array<{ version: number; created_by: string; created_at: string }> }>(id ? `campaigns/${id}` : null);
  const { me, toast } = useGlobal(); const err = useErr(); const router = useRouter();
  const [val, setVal] = useState<Validation | null>(null); const [sim, setSim] = useState<Record<string, unknown> | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null); const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { setVal(null); setSim(null); }, [id]);
  const act = async (action: string) => {
    setBusy(action);
    try {
      const r = await api<Record<string, unknown>>(`campaigns/${id}/action`, { body: { action } });
      if (action === "validate") setVal(r as unknown as Validation);
      else if (action === "simulate") { setSim(r); toast({ kind: "info", title: "Simulation complete", body: `${fmt.int(r.sent)} would be sent, ${fmt.int(r.blocked)} blocked` }); }
      else if (action === "submit") { setVal((r as { validation: Validation }).validation); toast({ kind: "success", title: "Submitted for approval", body: String(r.approvalId) }); }
      else if (action === "execute") toast({ kind: "success", title: "Campaign executed (mock sending)", body: `${fmt.int(r.sent)} sent · ${fmt.int(r.blocked)} blocked · ${fmt.int(r.duplicates)} duplicates prevented` });
      else if (action === "duplicate") { toast({ kind: "success", title: "Duplicated as draft" }); onChanged(); onOpen(String(r.id)); setBusy(null); return; }
      else toast({ kind: "success", title: `Campaign ${action}d` });
      d.refresh(); onChanged();
    } catch (e) { err(e, `${action} failed`); }
    setBusy(null); setConfirm(null);
  };
  const c = d.data?.campaign;
  const st = c?.status ?? "";
  const editable = ["draft", "changes_requested", "rejected"].includes(st);
  return (
    <Drawer open={!!id} onClose={onClose} title={c?.name ?? "Campaign"} width={720}>
      {!d.data || !c ? <Loading /> : <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" loading={busy === "validate"} onClick={() => act("validate")}>Validate</Button>
          <Button size="sm" loading={busy === "simulate"} onClick={() => act("simulate")}>Simulate</Button>
          {can(me, "campaigns.write") && editable && <Button size="sm" variant="primary" loading={busy === "submit"} onClick={() => act("submit")}>Submit for approval</Button>}
          {can(me, "campaigns.execute") && (st === "approved" || st === "paused") && <Button size="sm" variant="primary" onClick={() => setConfirm("execute")}>Execute</Button>}
          {can(me, "campaigns.write") && !["completed", "cancelled", "paused"].includes(st) && <Button size="sm" onClick={() => act("pause")}>Pause</Button>}
          {can(me, "campaigns.write") && !["completed", "cancelled"].includes(st) && <Button size="sm" variant="danger" onClick={() => setConfirm("cancel")}>Cancel</Button>}
          {can(me, "campaigns.write") && <Button size="sm" variant="ghost" loading={busy === "duplicate"} onClick={() => act("duplicate")}>Duplicate</Button>}
          {c.approval_id && <Button size="sm" variant="ghost" onClick={() => router.push(`/compliance?tab=approvals&id=${c.approval_id}`)}>View approval</Button>}
        </div>
        <KV items={[["Status", <Status key="s" value={c.status} />], ["Objective", c.objective.replace(/_/g, " ")], ["Purpose", <Badge key="p" tone={PURPOSE_TONE[c.purpose]}>{c.purpose}</Badge>], ["Audience", `${c.segment_name ?? c.segment_id ?? "–"} (${fmt.int(c.member_count)})`], ["Channels", c.channels.join(" → ")], ["Template", c.template_id ?? "–"], ["A/B test", c.ab_test ? `B = ${c.ab_test.variant_b_template_id}, ${Math.round(c.ab_test.split * 100)}% to B` : "none"], ["Schedule", c.schedule_at ? `${fmt.date(c.schedule_at)} (${c.timezone})` : `send on execution (${c.timezone})`], ["Budget", fmt.money(c.budget)], ["Routing strategy", c.strategy_version ? `channel_routing v${c.strategy_version}` : "pinned at execution"], ["Version", `v${c.version}`]]} />
        {val && <Card title="Pre-flight validation"><ValidationView v={val} /></Card>}
        {sim && <Notice>Simulation: {fmt.int(sim.sent)} would be sent, {fmt.int(sim.blocked)} blocked, est. cost {fmt.money(sim.cost)} (A {fmt.int((sim.variants as Record<string, number>)?.A)} / B {fmt.int((sim.variants as Record<string, number>)?.B)}). Nothing was persisted.</Notice>}
        {d.data.byStatus.length > 0 && <div className="grid md:grid-cols-2 gap-3">
          <Card title="Delivery status"><Chart height={200} option={bar(d.data.byStatus.map((x) => x.status), [{ name: "Messages", data: d.data.byStatus.map((x) => x.n) }])} /></Card>
          <Card title="Cost by channel"><DataTable dense rows={d.data.byChannel as unknown as Record<string, unknown>[]} rowKey={(r) => String(r.channel)} cols={[{ key: "channel", label: "Channel" }, { key: "n", label: "Messages", align: "right", render: (r) => fmt.int(r.n) }, { key: "cost", label: "Cost", align: "right", render: (r) => fmt.money(r.cost) }]} /></Card>
        </div>}
        {d.data.byVariant.some((v) => v.variant) && <Card title="A/B test results" subtitle="Randomized split — differences support causal comparison only with adequate sample size">
          <DataTable dense rows={d.data.byVariant as unknown as Record<string, unknown>[]} rowKey={(r) => String(r.variant)} cols={[{ key: "variant", label: "Variant", render: (r) => String(r.variant ?? "A") }, { key: "sent", label: "Sent", align: "right" }, { key: "delivered", label: "Delivered", align: "right" }, { key: "rr", label: "Read rate", align: "right", render: (r) => fmt.pct(Number(r.read) / Math.max(1, Number(r.delivered))) }, { key: "ctr", label: "CTR", align: "right", render: (r) => fmt.pct(Number(r.clicked) / Math.max(1, Number(r.delivered))) }]} />
        </Card>}
        <div><div className="text-xs font-semibold mb-1">Version history</div><DataTable dense rows={d.data.versions as unknown as Record<string, unknown>[]} rowKey={(r) => String(r.version)} cols={[{ key: "version", label: "Ver", render: (r) => `v${r.version}` }, { key: "created_by", label: "By" }, { key: "created_at", label: "At", render: (r) => fmt.date(r.created_at) }]} /></div>
      </div>}
      <Confirm open={confirm === "execute"} onClose={() => setConfirm(null)} onConfirm={() => act("execute")} loading={busy === "execute"} title="Execute campaign?" confirmLabel="Execute (mock sending)"
        body="Messages are created through the compliance-enforced send path using mock provider adapters — no real messages are sent. Consent, exclusions, frequency caps and quiet hours are re-checked per player; sends are idempotent." />
      <Confirm open={confirm === "cancel"} onClose={() => setConfirm(null)} onConfirm={() => act("cancel")} loading={busy === "cancel"} danger title="Cancel campaign?" confirmLabel="Cancel campaign" body="Queued messages are cancelled. This cannot be undone; duplicate the campaign to run it again." />
    </Drawer>
  );
}

const STEPS = ["Objective", "Audience", "Content & channels", "Schedule & budget", "Review"];
function Wizard({ onClose, onDone, initial }: { onClose: () => void; onDone: (id: string) => void; initial: { segment: string; template: string; name: string } }) {
  const meta = useApi<Meta>("campaigns/meta"); const { toast } = useGlobal(); const err = useErr();
  const [step, setStep] = useState(0);
  const [f, setF] = useState({ name: initial.name, objective: "service_communication", segment_id: initial.segment, template_id: initial.template, channels: [] as string[], ab: false, b_template: "", split: 50, sendNow: true, schedule_at: "", timezone: "Asia/Manila", budget: "5000" });
  const [created, setCreated] = useState<string | null>(null); const [val, setVal] = useState<Validation | null>(null); const [busy, setBusy] = useState(false);
  const m = meta.data;
  useEffect(() => { if (m && initial.template) { const t = m.templates.find((x) => x.id === initial.template); if (t) setF((s) => ({ ...s, channels: s.channels.length ? s.channels : [t.channel], objective: PROMO(t.purpose) ? (t.purpose === "marketing" ? "regulated_marketing" : "membership_communication") : s.objective })); } }, [m, initial.template]);
  const purpose = m?.objectives[f.objective]?.purpose ?? "service";
  const seg = m?.segments.find((s) => s.id === f.segment_id);
  const tpls = (m?.templates ?? []).filter((t) => t.status === "approved" && PROMO(t.purpose) === PROMO(purpose));
  const tpl = m?.templates.find((t) => t.id === f.template_id);
  const preview = (tpl?.body ?? "").replace(/\{\{\s*first_name\s*\}\}/g, "Andrea").replace(/\{\{\s*player_id\s*\}\}/g, "P100000");
  const segMismatch = seg && PROMO(seg.purpose) !== PROMO(purpose);
  const estCost = (seg?.member_count ?? 0) * (m?.channels.find((c) => c.key === f.channels[0])?.cost_per_message ?? 0);
  const canNext = [!!f.objective && f.name.length >= 3, !!f.segment_id, !!f.template_id && f.channels.length > 0 && (!f.ab || !!f.b_template), f.sendNow || !!f.schedule_at, true][step];
  const move = (i: number, dir: -1 | 1) => setF((s) => { const c = [...s.channels]; const j = i + dir; if (j < 0 || j >= c.length) return s; [c[i], c[j]] = [c[j], c[i]]; return { ...s, channels: c }; });
  const create = async () => {
    setBusy(true);
    try {
      const body = { name: f.name, objective: f.objective, segment_id: f.segment_id, channels: f.channels, template_id: f.template_id, schedule_at: f.sendNow ? null : new Date(f.schedule_at).toISOString(), timezone: f.timezone, budget: Number(f.budget) || 0, ab_test: f.ab ? { variant_b_template_id: f.b_template, split: f.split / 100 } : null };
      let id = created;
      if (!id) { const c = await api<{ id: string }>("campaigns", { body }); id = c.id; setCreated(id); }
      else await api(`campaigns/${id}`, { method: "PUT", body: { name: body.name, segment_id: body.segment_id, channels: body.channels, template_id: body.template_id, schedule_at: body.schedule_at, budget: body.budget, ab_test: body.ab_test } });
      setVal(await api<Validation>(`campaigns/${id}/action`, { body: { action: "validate" } }));
    } catch (e) { err(e, "Could not save campaign"); }
    setBusy(false);
  };
  const submit = async () => {
    setBusy(true);
    try { const r = await api<{ approvalId: string }>(`campaigns/${created}/action`, { body: { action: "submit" } }); toast({ kind: "success", title: "Submitted for approval", body: r.approvalId }); onDone(created!); }
    catch (e) { err(e, "Submit failed"); }
    setBusy(false);
  };
  useEffect(() => { if (step === 4 && !val && !busy) void create(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [step]);
  return (
    <Drawer open onClose={onClose} title="New campaign" width={720} footer={<>
      <Button onClick={onClose}>Cancel</Button>
      {step > 0 && <Button onClick={() => { setStep(step - 1); setVal(null); }}>Back</Button>}
      {step < 4 ? <Button variant="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>Next</Button> : <>
        <Button disabled={!created} onClick={() => { toast({ kind: "success", title: "Draft saved" }); onDone(created!); }}>Save draft</Button>
        <Button variant="primary" loading={busy} disabled={!val?.ok} onClick={submit}>Submit for approval</Button></>}
    </>}>
      {!m ? <Loading /> : <div className="space-y-4">
        <ol className="flex flex-wrap gap-1 text-[12px]">{STEPS.map((s, i) => <li key={s}><button disabled={i > step} onClick={() => { setStep(i); setVal(null); }} className={cx("rounded-full px-2.5 py-1 border", i === step ? "border-accent bg-accent-soft text-accent font-medium" : i < step ? "border-border text-fg" : "border-border text-faint")}>{i + 1}. {s}</button></li>)}</ol>
        <Notice>Mock sending is used by default — no real messages leave the platform. Real channels must be verified in Settings before live use.</Notice>

        {step === 0 && <div className="space-y-3">
          <Field label="Campaign name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. KYC help — failed documents" /></Field>
          <div className="text-xs font-medium text-muted">Objective (explicit purpose classification)</div>
          <div className="grid sm:grid-cols-2 gap-2">{Object.entries(m.objectives).map(([k, o]) => (
            <button key={k} onClick={() => setF({ ...f, objective: k, template_id: "", b_template: "" })} className={cx("text-left rounded-md border p-3", f.objective === k ? "border-accent bg-accent-soft/40" : "border-border hover:border-border-strong")}>
              <div className="text-[13px] font-medium">{o.label}</div><div className="text-xs text-muted mt-0.5">Purpose: <Badge tone={PURPOSE_TONE[o.purpose]}>{o.purpose}</Badge>{PROMO(o.purpose) && " · promotional rules apply (KYC, 21+, marketing consent, exclusions, caps, quiet hours)"}</div>
            </button>))}</div>
        </div>}

        {step === 1 && <div className="space-y-3">
          <Field label="Audience segment"><Select value={f.segment_id} onChange={(e) => setF({ ...f, segment_id: e.target.value })} options={[{ value: "", label: "Select a segment…" }, ...m.segments.map((s) => ({ value: s.id, label: `${s.name} · ${fmt.int(s.member_count)} · ${s.purpose}` }))]} /></Field>
          {seg && <KV items={[["Members", fmt.int(seg.member_count)], ["Segment purpose", <Badge key="p" tone={PURPOSE_TONE[seg.purpose]}>{seg.purpose}</Badge>]]} />}
          {segMismatch && <Notice tone="warn">Segment purpose ({seg!.purpose}) differs from the campaign purpose ({purpose}). Promotional sends will still apply mandatory exclusions at execution time.</Notice>}
          <Notice>Consent and compliance exclusions are applied at execution, not at segment time.</Notice>
        </div>}

        {step === 2 && <div className="space-y-3">
          <Field label={`Template (approved, ${PROMO(purpose) ? "promotional" : "non-promotional"} purpose)`}><Select value={f.template_id} onChange={(e) => { const t = m.templates.find((x) => x.id === e.target.value); setF({ ...f, template_id: e.target.value, channels: t && !f.channels.includes(t.channel) ? [t.channel, ...f.channels] : f.channels }); }} options={[{ value: "", label: "Select template…" }, ...tpls.map((t) => ({ value: t.id, label: `${t.name} · ${t.channel}` }))]} /></Field>
          {!tpls.length && <Notice tone="warn">No approved templates match this purpose. Create and approve one in Omni Channel → Templates.</Notice>}
          {tpl && <div className="rounded-md border border-border bg-panel-2 p-3"><div className="text-[11px] text-faint mb-1">Preview · {tpl.channel} · {tpl.purpose}</div><div className="text-[13px] whitespace-pre-wrap">{preview}</div></div>}
          <div>
            <div className="text-xs font-medium text-muted mb-1">Channels (priority order — players blocked on one channel fall back to the next consented channel)</div>
            <div className="space-y-1">{f.channels.map((ch, i) => { const c = m.channels.find((x) => x.key === ch); return (
              <div key={ch} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-[12.5px]"><span className="text-faint w-4">{i + 1}</span><span className="flex-1">{c?.name ?? ch}</span>{c?.health && c.health !== "healthy" && <Status value={c.health} />}<span className="text-muted">{fmt.money(c?.cost_per_message)}/msg</span>
                <button aria-label="Move up" onClick={() => move(i, -1)} className="p-0.5 text-faint hover:text-fg"><ArrowUp size={13} /></button><button aria-label="Move down" onClick={() => move(i, 1)} className="p-0.5 text-faint hover:text-fg"><ArrowDown size={13} /></button><button aria-label="Remove" onClick={() => setF({ ...f, channels: f.channels.filter((x) => x !== ch) })} className="p-0.5 text-faint hover:text-bad"><X size={13} /></button></div>); })}</div>
            <Select className="mt-2" value="" onChange={(e) => e.target.value && setF({ ...f, channels: [...f.channels, e.target.value] })} options={[{ value: "", label: "+ Add channel" }, ...m.channels.filter((c) => !f.channels.includes(c.key)).map((c) => ({ value: c.key, label: `${c.name} (${fmt.money(c.cost_per_message)}/msg)` }))]} />
          </div>
          <div className="rounded-md border border-border p-3 space-y-2">
            <label className="flex items-center gap-2 text-[13px]"><Toggle checked={f.ab} onChange={(v) => setF({ ...f, ab: v })} />A/B test</label>
            {f.ab && <div className="grid grid-cols-2 gap-3">
              <Field label="Variant B template"><Select value={f.b_template} onChange={(e) => setF({ ...f, b_template: e.target.value })} options={[{ value: "", label: "Select…" }, ...tpls.filter((t) => t.id !== f.template_id).map((t) => ({ value: t.id, label: `${t.name} · ${t.channel}` }))]} /></Field>
              <Field label={`Split to B: ${f.split}%`}><input type="range" min={5} max={95} value={f.split} onChange={(e) => setF({ ...f, split: Number(e.target.value) })} /></Field>
            </div>}
          </div>
        </div>}

        {step === 3 && <div className="space-y-3">
          <label className="flex items-center gap-2 text-[13px]"><Toggle checked={f.sendNow} onChange={(v) => setF({ ...f, sendNow: v })} />Send on execution (after approval)</label>
          {!f.sendNow && <Field label="Scheduled time"><Input type="datetime-local" value={f.schedule_at} onChange={(e) => setF({ ...f, schedule_at: e.target.value })} /></Field>}
          <Field label="Time zone"><Select value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} options={["Asia/Manila", "Asia/Singapore", "Asia/Shanghai", "UTC"]} /></Field>
          <Field label="Campaign budget (PHP)" hint={`Estimated cost at full reach on ${f.channels[0] ?? "primary channel"}: ${fmt.money(estCost)} (before compliance exclusions)`}><Input type="number" value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value })} /></Field>
          {PROMO(purpose) && <Notice tone="warn">Promotional sends are blocked during quiet hours (22:00–08:00 local) and are subject to frequency caps.</Notice>}
        </div>}

        {step === 4 && <div className="space-y-3">
          <KV items={[["Name", f.name], ["Objective", m.objectives[f.objective]?.label], ["Purpose", purpose], ["Audience", `${seg?.name} (${fmt.int(seg?.member_count)})`], ["Template", tpl?.name], ["Channels", f.channels.join(" → ")], ["A/B", f.ab ? `${f.split}% to ${f.b_template}` : "none"], ["Schedule", f.sendNow ? "on execution" : `${f.schedule_at} ${f.timezone}`], ["Budget", fmt.money(f.budget)]]} />
          {busy && !val ? <Loading rows={3} /> : val ? <Card title="Validation (consent · frequency · quiet hours · exclusions · budget)"><ValidationView v={val} /></Card> : <Empty title="Not validated" action={<Button onClick={create}>Validate</Button>} />}
          {val && !val.ok && <Notice tone="bad">Fix the errors above (go Back to edit) before submitting. The draft is saved{created ? ` as ${created}` : ""}.</Notice>}
          {val?.ok && <Button size="sm" variant="ghost" onClick={create}>Re-validate</Button>}
        </div>}
      </div>}
    </Drawer>
  );
}

export default function Page() { return <Suspense fallback={<Loading />}><CampaignsInner /></Suspense>; }
