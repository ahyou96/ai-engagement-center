"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, Play, RefreshCw } from "lucide-react";
import { api, ApiError, can, fmt, useApi, useGlobal } from "@/components/hooks";
import { Badge, Button, Card, Confirm, DataTable, Drawer, Empty, ErrorState, Field, Input, JsonView, KV, Loading, Modal, Notice, PageHeader, Select, Stat, Status, Tabs, Textarea, Toggle, cx } from "@/components/ui";
import { Chart, bar } from "@/components/chart";

type Offer = { id: string; name: string; category: string; description: string | null; base_amount: number; unit: string; eligibility: Record<string, unknown>; validity_days: number; per_user_limit: number; status: string; version: number; requires_approval: number; allow_personalization: number; issued: number; updated_at: string };
type Seg = { id: string; name: string; purpose: string; member_count: number };
type Decision = { player_id: string; offer_id: string; outcome: string; base_amount: number; approved_amount: number; rules: string[]; reason: string; budget: { ok: boolean; remaining: number; ratio: number; note?: string }; compliance: { ok: boolean; reasons: string[] } };
type Summary = { evaluated: number; eligible: number; distribution: Record<string, number>; total_amount: number; none_reasons: Record<string, number> };

const CAT_TONE: Record<string, string> = { membership_benefit: "accent", service_compensation: "info", contractual: "ok", regulated_promotion: "warn" };
const OUT_TONE: Record<string, string> = { none: "neutral", reduced: "warn", standard: "info", enhanced: "ok" };
const CATS = ["membership_benefit", "service_compensation", "contractual", "regulated_promotion"];

function useErr() {
  const { toast } = useGlobal();
  return (e: unknown, title = "Action failed") => {
    const err = e as ApiError;
    const d = Array.isArray(err.details) ? (err.details as Array<{ message?: string }>).map((x) => x.message ?? JSON.stringify(x)).join("; ") : undefined;
    toast({ kind: "error", title: `${title}: ${err.message}`, body: d });
  };
}

function OffersInner() {
  const sp = useSearchParams(); const router = useRouter(); const { t } = useGlobal();
  const tab = sp.get("tab") ?? "catalog";
  const setTab = (k: string) => { const p = new URLSearchParams(sp.toString()); p.set("tab", k); router.replace(`/offers?${p}`); };
  const offers = useApi<Offer[]>("offers");
  return (
    <div className="space-y-4">
      <PageHeader title={t("offers")} subtitle="Individual entitlement decisions — deterministic, explainable, budget- and compliance-controlled" />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: "catalog", label: "Catalog", count: offers.data?.length }, { key: "simulator", label: "Decision simulator" }, { key: "decisions", label: "Decisions" }, { key: "budgets", label: "Budgets" }, { key: "transactions", label: "Transactions" }, { key: "analytics", label: "Analytics" }]} />
      <ErrorState error={offers.error} onRetry={offers.refresh} />
      {tab === "catalog" && <Catalog offers={offers.data} loading={offers.loading} refresh={offers.refresh} initialId={sp.get("id")} />}
      {tab === "simulator" && <Simulator offers={offers.data ?? []} />}
      {tab === "decisions" && <Decisions offers={offers.data ?? []} />}
      {tab === "budgets" && <Budgets offers={offers.data ?? []} />}
      {tab === "transactions" && <Transactions offers={offers.data ?? []} />}
      {tab === "analytics" && <Analytics />}
    </div>
  );
}

function Catalog({ offers, loading, refresh, initialId }: { offers: Offer[] | null; loading: boolean; refresh: () => void; initialId: string | null }) {
  const [sel, setSel] = useState<string | null>(initialId); const [create, setCreate] = useState(false);
  return (
    <>
      <Notice>
        <b>Membership benefits</b> reward tenure/tier and may be personalized by approved tiers · <b>Service compensation</b> is tied to documented service impact (e.g. failed launches) · <b>Contractual</b> entitlements are fixed amounts owed by agreement · <b>Regulated promotions</b> are uniform, never personalized, and require KYC, 21+ and marketing consent.
      </Notice>
      <Card title="Offer catalog" actions={<Button size="sm" variant="primary" onClick={() => setCreate(true)}><Plus size={13} />New offer</Button>} pad={false}>
        <div className="p-3">{loading && !offers ? <Loading /> : <DataTable rows={(offers ?? []) as unknown as Record<string, unknown>[]} exportName="offers" search={(r) => `${r.name} ${r.category}`} onRow={(r) => setSel(String(r.id))} cols={[
          { key: "name", label: "Offer", render: (r) => <span className="font-medium">{String(r.name)}</span> },
          { key: "category", label: "Category", render: (r) => <Badge tone={CAT_TONE[String(r.category)]}>{String(r.category).replace(/_/g, " ")}</Badge> },
          { key: "status", label: "Status", render: (r) => <Status value={String(r.status)} /> },
          { key: "base_amount", label: "Base", align: "right", render: (r) => fmt.money(r.base_amount) },
          { key: "per_user_limit", label: "Per user", align: "right" },
          { key: "requires_approval", label: "Approval", render: (r) => (r.requires_approval ? <Badge tone="warn">required</Badge> : <Badge>auto</Badge>) },
          { key: "issued", label: "Issued", align: "right", render: (r) => fmt.int(r.issued) },
          { key: "version", label: "Ver", align: "right", render: (r) => `v${r.version}` },
        ]} />}</div>
      </Card>
      <OfferDrawer id={sel} onClose={() => setSel(null)} onChanged={refresh} />
      <CreateOffer open={create} onClose={() => setCreate(false)} onCreated={refresh} />
    </>
  );
}

function OfferDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const d = useApi<{ offer: Offer; versions: Array<Record<string, unknown>>; budget: Record<string, number> | null; batches: Array<Record<string, unknown>> }>(id ? `offers/${id}` : null);
  const { toast, me } = useGlobal(); const err = useErr();
  const [edit, setEdit] = useState<{ base: string; elig: string; status: string } | null>(null);
  useEffect(() => { if (d.data) setEdit({ base: String(d.data.offer.base_amount), elig: JSON.stringify(d.data.offer.eligibility, null, 2), status: d.data.offer.status }); }, [d.data]);
  const save = async () => {
    if (!edit || !d.data) return;
    let elig: unknown; try { elig = JSON.parse(edit.elig); } catch { toast({ kind: "error", title: "Eligibility must be valid JSON" }); return; }
    try { await api(`offers/${id}`, { method: "PUT", body: { base_amount: Number(edit.base), eligibility: elig, ...(edit.status !== d.data.offer.status ? { status: edit.status } : {}) } }); toast({ kind: "success", title: "Offer updated (new version)" }); d.refresh(); onChanged(); }
    catch (e) { err(e, "Update failed"); }
  };
  const o = d.data?.offer;
  return (
    <Drawer open={!!id} onClose={onClose} title={o?.name ?? "Offer"} width={620} footer={can(me, "offers.write") ? <Button variant="primary" onClick={save}>Save new version</Button> : undefined}>
      {!d.data ? <Loading /> : o && edit && <div className="space-y-4">
        <KV items={[["Category", <Badge key="c" tone={CAT_TONE[o.category]}>{o.category.replace(/_/g, " ")}</Badge>], ["Status", <Status key="s" value={o.status} />], ["Version", `v${o.version}`], ["Validity", `${o.validity_days} days`], ["Per-user limit", o.per_user_limit], ["Personalization", o.allow_personalization ? "approved tiers" : "uniform amount"], ["Approval", o.requires_approval ? "required before issuance" : "not required"], ["Description", o.description ?? "–"]]} />
        {d.data.budget ? <div className="text-xs"><div className="font-medium mb-1">Budget: {String((d.data.budget as unknown as { name: string }).name)}</div><BudgetBar b={d.data.budget} /></div> : <Notice tone="warn">No active budget for this offer.</Notice>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Base amount (PHP)"><Input type="number" value={edit.base} onChange={(e) => setEdit({ ...edit, base: e.target.value })} /></Field>
          <Field label="Status" hint="Activating requires an approver role"><Select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })} options={["draft", "active", "paused", "archived"]} /></Field>
        </div>
        <Field label="Eligibility conditions (JSON)" hint="Supported: kyc_required, min_tenure_days, vip_tiers, platforms, min_launch_failures_7d"><Textarea rows={6} className="font-mono text-xs" value={edit.elig} onChange={(e) => setEdit({ ...edit, elig: e.target.value })} /></Field>
        <div><div className="text-xs font-semibold mb-1">Recent decision batches</div>
          <DataTable dense rows={d.data.batches} rowKey={(r) => String(r.batch_id)} cols={[{ key: "at", label: "When", render: (r) => fmt.date(r.at) }, { key: "n", label: "Evaluated", align: "right" }, { key: "eligible", label: "Eligible", align: "right" }, { key: "amount", label: "Amount", align: "right", render: (r) => fmt.money(r.amount) }, { key: "strategy_version", label: "Strategy", render: (r) => `v${r.strategy_version}` }, { key: "status", label: "Approval", render: (r) => <Status value={String(r.status)} /> }, { key: "simulated", label: "", render: (r) => (r.simulated ? <Badge>sim</Badge> : null) }]} />
        </div>
        <div><div className="text-xs font-semibold mb-1">Version history</div><DataTable dense rows={d.data.versions} rowKey={(r) => String(r.version)} cols={[{ key: "version", label: "Ver", render: (r) => `v${r.version}` }, { key: "created_by", label: "By" }, { key: "created_at", label: "At", render: (r) => fmt.date(r.created_at) }, { key: "snapshot", label: "Change", render: (r) => <code className="text-[11px] font-mono break-all">{String(r.snapshot).slice(0, 90)}</code> }]} /></div>
      </div>}
    </Drawer>
  );
}

function CreateOffer({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { toast } = useGlobal(); const err = useErr();
  const [f, setF] = useState({ name: "", category: "membership_benefit", base_amount: "100", validity_days: "14", per_user_limit: "1", kyc: true, tenure: "30", requires_approval: true, description: "" });
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try { await api("offers", { body: { name: f.name, category: f.category, description: f.description || undefined, base_amount: Number(f.base_amount), validity_days: Number(f.validity_days), per_user_limit: Number(f.per_user_limit), requires_approval: f.requires_approval, eligibility: { kyc_required: f.kyc, min_tenure_days: Number(f.tenure) } } }); toast({ kind: "success", title: "Offer created as draft" }); onCreated(); onClose(); }
    catch (e) { err(e, "Create failed"); }
    setBusy(false);
  };
  return (
    <Modal open={open} onClose={onClose} title="New entitlement configuration" width={540} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={f.name.length < 3} onClick={submit}>Create draft</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2"><Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field></div>
        <Field label="Category"><Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} options={CATS.map((c) => ({ value: c, label: c.replace(/_/g, " ") }))} /></Field>
        <Field label="Base amount (PHP)"><Input type="number" value={f.base_amount} onChange={(e) => setF({ ...f, base_amount: e.target.value })} /></Field>
        <Field label="Validity (days)"><Input type="number" value={f.validity_days} onChange={(e) => setF({ ...f, validity_days: e.target.value })} /></Field>
        <Field label="Per-user limit"><Input type="number" value={f.per_user_limit} onChange={(e) => setF({ ...f, per_user_limit: e.target.value })} /></Field>
        <Field label="Min tenure (days)"><Input type="number" value={f.tenure} onChange={(e) => setF({ ...f, tenure: e.target.value })} /></Field>
        <div className="flex flex-col gap-2 text-xs"><label className="flex items-center gap-2"><Toggle checked={f.kyc} onChange={(v) => setF({ ...f, kyc: v })} />KYC required</label><label className="flex items-center gap-2"><Toggle checked={f.requires_approval} onChange={(v) => setF({ ...f, requires_approval: v })} />Approval before issuance</label></div>
        <div className="col-span-2"><Field label="Description"><Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field></div>
      </div>
      {f.category === "regulated_promotion" && <Notice tone="warn" className="mt-3">Regulated promotions are uniform (no personalization) and require KYC, 21+ and marketing consent.</Notice>}
    </Modal>
  );
}

function BudgetBar({ b }: { b: Record<string, number> }) {
  const total = Number(b.total) || 1; const s = (Number(b.spent) / total) * 100; const r = (Number(b.reserved) / total) * 100;
  return (
    <div>
      <div className="h-2.5 w-full rounded-full bg-panel-2 border border-border overflow-hidden flex"><div className="bg-accent" style={{ width: `${s}%` }} /><div className="bg-warn" style={{ width: `${r}%` }} /></div>
      <div className="flex gap-3 mt-1 text-[11px] text-muted"><span><span className="inline-block w-2 h-2 rounded-sm bg-accent mr-1" />spent {fmt.money(b.spent)}</span><span><span className="inline-block w-2 h-2 rounded-sm bg-warn mr-1" />reserved {fmt.money(b.reserved)}</span><span>remaining {fmt.money(total - Number(b.spent) - Number(b.reserved))} of {fmt.money(b.total)}</span></div>
    </div>
  );
}

function Simulator({ offers }: { offers: Offer[] }) {
  const meta = useApi<{ segments: Seg[] }>("campaigns/meta");
  const strat = useApi<{ versions: Array<{ status: string; version: number; config: Record<string, unknown> }> }>("strategies/str_membership_entitlements");
  const active = strat.data?.versions.find((v) => v.status === "active");
  const [offerId, setOfferId] = useState("off_member_monthly"); const [segId, setSegId] = useState("seg_02");
  const [tiers, setTiers] = useState({ none: "0", reduced: "0.5", standard: "1", enhanced: "1.5" });
  const [params, setParams] = useState({ enhanced_min_tenure_days: "365", standard_min_tenure_days: "30", reduced_when_budget_ratio_below: "0.15" });
  useEffect(() => {
    if (!active) return; const c = active.config as { tiers?: Record<string, number>; enhanced_min_tenure_days?: number; standard_min_tenure_days?: number; reduced_when_budget_ratio_below?: number };
    if (c.tiers) setTiers({ none: String(c.tiers.none), reduced: String(c.tiers.reduced), standard: String(c.tiers.standard), enhanced: String(c.tiers.enhanced) });
    setParams({ enhanced_min_tenure_days: String(c.enhanced_min_tenure_days ?? 365), standard_min_tenure_days: String(c.standard_min_tenure_days ?? 30), reduced_when_budget_ratio_below: String(c.reduced_when_budget_ratio_below ?? 0.15) });
  }, [active]);
  const [res, setRes] = useState<{ strategy: { version: number }; summary: Summary; decisions: Decision[] } | null>(null);
  const [busy, setBusy] = useState(false); const [confirm, setConfirm] = useState(false); const [batch, setBatch] = useState<{ batch_id: string; approval_id?: string; summary: Summary } | null>(null);
  const { toast, me } = useGlobal(); const err = useErr(); const router = useRouter();
  const offer = offers.find((o) => o.id === offerId);
  const budget = useApi<{ budget: Record<string, number> | null }>(offerId ? `offers/${offerId}` : null);
  const run = async () => {
    setBusy(true);
    try {
      const config = { tiers: Object.fromEntries(Object.entries(tiers).map(([k, v]) => [k, Number(v)])), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, Number(v)])) };
      setRes(await api(`offers/${offerId}/simulate`, { body: { segment_id: segId, config } }));
    } catch (e) { err(e, "Simulation failed"); }
    setBusy(false);
  };
  const runBatch = async () => {
    try { const r = await api<{ batch_id: string; approval_id?: string; summary: Summary }>(`offers/${offerId}/batch`, { body: { segment_id: segId, simulate: false } }); setBatch(r); toast({ kind: "success", title: r.approval_id ? "Batch submitted for approval" : "Batch evaluated", body: `${r.summary.eligible} eligible · ${fmt.money(r.summary.total_amount)}` }); }
    catch (e) { err(e, "Batch failed"); }
    setConfirm(false);
  };
  const dist = res?.summary.distribution;
  return (
    <div className="space-y-3">
      <Notice tone="warn"><b>Decisions never use deposits, losses, wagering or vulnerability signals; regulated promotions are never personalized.</b> Inputs: membership tier, tenure, KYC, documented service impact, budget, existing entitlements, compliance status and the approved strategy configuration. Simulations issue nothing.</Notice>
      <div className="grid lg:grid-cols-[320px_1fr] gap-3">
        <Card title="Inputs" subtitle={active ? `Defaults from active strategy v${active.version}` : "Loading strategy…"}>
          <div className="space-y-3">
            <Field label="Offer"><Select value={offerId} onChange={(e) => setOfferId(e.target.value)} options={offers.map((o) => ({ value: o.id, label: `${o.name} (${o.status})` }))} /></Field>
            <Field label="Audience segment"><Select value={segId} onChange={(e) => setSegId(e.target.value)} options={(meta.data?.segments ?? []).map((s) => ({ value: s.id, label: `${s.name} · ${s.member_count}` }))} /></Field>
            {offer && <div className="text-xs text-muted">Base {fmt.money(offer.base_amount)} · <Badge tone={CAT_TONE[offer.category]}>{offer.category.replace(/_/g, " ")}</Badge>{!offer.allow_personalization && <span> · uniform (tiers ignored)</span>}</div>}
            <div className="text-xs font-semibold">Tier multipliers (configurable demo values)</div>
            <div className="grid grid-cols-4 gap-2">{(["none", "reduced", "standard", "enhanced"] as const).map((k) => <Field key={k} label={k}><Input type="number" step="0.1" value={tiers[k]} onChange={(e) => setTiers({ ...tiers, [k]: e.target.value })} /></Field>)}</div>
            <Field label="Enhanced: min tenure (days)"><Input type="number" value={params.enhanced_min_tenure_days} onChange={(e) => setParams({ ...params, enhanced_min_tenure_days: e.target.value })} /></Field>
            <Field label="Standard: min tenure (days)"><Input type="number" value={params.standard_min_tenure_days} onChange={(e) => setParams({ ...params, standard_min_tenure_days: e.target.value })} /></Field>
            <Field label="Budget guard: downgrade to reduced below ratio"><Input type="number" step="0.05" value={params.reduced_when_budget_ratio_below} onChange={(e) => setParams({ ...params, reduced_when_budget_ratio_below: e.target.value })} /></Field>
            <div className="flex gap-2"><Button variant="primary" onClick={run} loading={busy}><Play size={13} />Simulate</Button>{can(me, "offers.write") && <Button onClick={() => setConfirm(true)}>Run batch…</Button>}</div>
            {batch && <Notice tone="ok">Batch <code>{batch.batch_id}</code>{batch.approval_id ? <> awaiting approval <button className="underline" onClick={() => router.push(`/compliance?tab=approvals&id=${batch.approval_id}`)}>{batch.approval_id}</button></> : " evaluated"}.</Notice>}
          </div>
        </Card>
        <div className="space-y-3 min-w-0">
          {!res ? <Card><Empty title="Run a simulation" body="Choose an offer and audience, adjust approved tiers, then Simulate." /></Card> : <>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              <Stat label="Evaluated" value={res.summary.evaluated} format={fmt.int} />
              <Stat label="Eligible" value={res.summary.eligible} format={fmt.int} />
              <Stat label="Total amount" value={res.summary.total_amount} format={fmt.money} />
              <Stat label="Budget remaining" value={budget.data?.budget ? Number(budget.data.budget.total) - Number(budget.data.budget.reserved) - Number(budget.data.budget.spent) : null} format={fmt.money} />
              <Stat label="Strategy" value={`v${res.strategy.version}`} />
            </div>
            <div className="grid md:grid-cols-2 gap-3">
              <Card title="Decision distribution">{dist && <Chart height={220} option={bar(["No offer", "Reduced", "Standard", "Enhanced"], [{ name: "Players", data: [dist.none, dist.reduced, dist.standard, dist.enhanced] }])} />}</Card>
              <Card title="No-offer reasons">{Object.keys(res.summary.none_reasons).length ? <div className="space-y-1.5">{Object.entries(res.summary.none_reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => <div key={k} className="flex justify-between text-[12.5px] border-b border-border pb-1"><span>{k}</span><span className="tabular-nums">{v}</span></div>)}</div> : <div className="text-xs text-muted">Every evaluated player received an offer.</div>}
                {budget.data?.budget && <div className="mt-3"><BudgetBar b={budget.data.budget} /><div className="text-[11px] text-muted mt-1">Simulated total {fmt.money(res.summary.total_amount)} would use {fmt.pct(res.summary.total_amount / Math.max(1, Number(budget.data.budget.total)))} of total budget.</div></div>}</Card>
            </div>
            <Card title="Individual decisions" subtitle="First 200 shown" pad={false}><div className="p-3"><DecisionTable rows={res.decisions.map((d) => ({ ...d, rules_applied: d.rules, budget_check: d.budget, compliance_check: d.compliance, strategy_version: res.strategy.version, approval_status: "simulated" }))} /></div></Card>
          </>}
        </div>
      </div>
      <Confirm open={confirm} onClose={() => setConfirm(false)} onConfirm={runBatch} title="Run entitlement batch?" confirmLabel="Evaluate & request approval"
        body={<>This persists decisions for every member of the selected segment (max 5,000) for <b>{offer?.name}</b>. If the offer requires approval, an approval request is created and nothing is issued until approved. Issuance is idempotent and uses mock wallets.</>} />
    </div>
  );
}

function parseMaybe<T>(v: unknown, d: T): T { if (typeof v !== "string") return (v as T) ?? d; try { return JSON.parse(v) as T; } catch { return d; } }

function DecisionTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  return <DataTable dense rows={rows} exportName="offer-decisions" search={(r) => `${r.player_id} ${r.outcome} ${r.reason}`} rowKey={(r, i) => `${r.player_id}${i}`} cols={[
    { key: "player_id", label: "Player", render: (r) => <a className="text-accent hover:underline" href={`/audience/${r.player_id}`} onClick={(e) => e.stopPropagation()}>{String(r.player_id)}</a> },
    ...(rows[0]?.offer_name ? [{ key: "offer_name", label: "Offer" }] : []),
    { key: "outcome", label: "Outcome", render: (r) => <Badge tone={OUT_TONE[String(r.outcome)]}>{String(r.outcome)}</Badge> },
    { key: "base_amount", label: "Base", align: "right", render: (r) => fmt.money(r.base_amount) },
    { key: "approved_amount", label: "Approved", align: "right", render: (r) => fmt.money(r.approved_amount) },
    { key: "rules_applied", label: "Rules", render: (r) => <span className="font-mono text-[11px]">{parseMaybe<string[]>(r.rules_applied, []).join(", ")}</span> },
    { key: "reason", label: "Reason", className: "max-w-[280px]", render: (r) => <span className="text-[12px]">{String(r.reason)}</span> },
    { key: "budget_check", label: "Budget", render: (r) => { const b = parseMaybe<{ ok: boolean; ratio?: number; note?: string }>(r.budget_check, { ok: true }); return <Badge tone={b.ok ? "ok" : "bad"}>{b.ok ? `ok${b.ratio != null && b.ratio !== 1 ? ` · ${Math.round(b.ratio * 100)}%` : ""}` : b.note ?? "fail"}</Badge>; } },
    { key: "compliance_check", label: "Compliance", render: (r) => { const c = parseMaybe<{ ok: boolean; reasons: string[] }>(r.compliance_check, { ok: true, reasons: [] }); return <Badge tone={c.ok ? "ok" : "bad"} title={c.reasons.join("; ")}>{c.ok ? "pass" : c.reasons[0] ?? "blocked"}</Badge>; } },
    { key: "strategy_version", label: "Strategy", render: (r) => (r.strategy_version != null ? `v${r.strategy_version}` : "–") },
    { key: "approval_status", label: "Approval", render: (r) => <Status value={String(r.approval_status)} /> },
    ...(rows[0]?.created_at ? [{ key: "created_at", label: "At", render: (r: Record<string, unknown>) => fmt.date(r.created_at) }] : []),
  ]} />;
}

function Decisions({ offers }: { offers: Offer[] }) {
  const [offerId, setOfferId] = useState("off_member_monthly");
  const detail = useApi<{ batches: Array<Record<string, unknown>> }>(offerId ? `offers/${offerId}` : null);
  const [batch, setBatch] = useState<string | null>(null);
  useEffect(() => { setBatch(null); }, [offerId]);
  useEffect(() => { if (!batch && detail.data?.batches[0]) setBatch(String(detail.data.batches[0].batch_id)); }, [detail.data, batch]);
  const rows = useApi<Array<Record<string, unknown>>>(batch ? `offers/batches/${batch}` : null);
  return (
    <div className="grid lg:grid-cols-[340px_1fr] gap-3">
      <Card title="Decision batches" actions={<Select value={offerId} onChange={(e) => setOfferId(e.target.value)} options={offers.map((o) => ({ value: o.id, label: o.name }))} className="max-w-44" />}>
        {detail.loading && !detail.data ? <Loading /> : !detail.data?.batches.length ? <Empty title="No batches yet" body="Run a simulation or batch from the simulator." /> :
          <div className="space-y-1.5">{detail.data.batches.map((b) => (
            <button key={String(b.batch_id)} onClick={() => setBatch(String(b.batch_id))} className={cx("w-full text-left rounded-md border px-2.5 py-2 text-[12px]", batch === b.batch_id ? "border-accent bg-accent-soft/40" : "border-border hover:border-border-strong")}>
              <div className="flex items-center gap-2"><code className="font-mono text-[11px] flex-1 truncate">{String(b.batch_id)}</code>{b.simulated ? <Badge>sim</Badge> : null}<Status value={String(b.status)} /></div>
              <div className="text-muted mt-0.5">{fmt.date(b.at)} · {fmt.int(b.eligible)}/{fmt.int(b.n)} eligible · {fmt.money(b.amount)} · strategy v{String(b.strategy_version)}</div>
            </button>))}</div>}
      </Card>
      <Card title="Decision transparency" subtitle="Every decision records outcome, amounts, rules, reason, budget & compliance validation, strategy version and approval status" pad={false}>
        <div className="p-3">{rows.loading ? <Loading /> : <DecisionTable rows={rows.data ?? []} />}</div>
      </Card>
    </div>
  );
}

function Budgets({ offers }: { offers: Offer[] }) {
  const b = useApi<Array<Record<string, unknown>>>("offers/budgets"); const rec = useApi<Array<Record<string, unknown>>>("offers/reconcile");
  const { me, toast } = useGlobal(); const err = useErr();
  const [open, setOpen] = useState(false); const [f, setF] = useState({ name: "", scope: "offer", offer_id: "", total: "50000", daily_limit: "", days: "30" });
  const recMap = useMemo(() => new Map((rec.data ?? []).map((r) => [String(r.id), r])), [rec.data]);
  const create = async () => {
    try { await api("offers/budgets", { body: { name: f.name, scope: f.scope, offer_id: f.offer_id || undefined, total: Number(f.total), daily_limit: f.daily_limit ? Number(f.daily_limit) : undefined, days: Number(f.days) } }); toast({ kind: "success", title: "Budget created" }); setOpen(false); b.refresh(); rec.refresh(); }
    catch (e) { err(e, "Create failed"); }
  };
  return (
    <div className="space-y-3">
      <Notice>Budgets are reserved atomically at issuance (<code>total − reserved − spent ≥ amount</code>), moved to spent at redemption and released on expiry/cancellation. A database CHECK prevents over-allocation.</Notice>
      <Card title="Budgets" actions={<><Button size="sm" variant="ghost" onClick={() => { b.refresh(); rec.refresh(); }}><RefreshCw size={13} /></Button>{can(me, "budgets.write") && <Button size="sm" variant="primary" onClick={() => setOpen(true)}><Plus size={13} />New budget</Button>}</>}>
        {b.loading && !b.data ? <Loading /> : <div className="grid md:grid-cols-2 gap-3">{(b.data ?? []).map((x) => {
          const r = recMap.get(String(x.id)) as { balanced?: boolean; reserved_diff?: number; spent_diff?: number } | undefined;
          return (
            <div key={String(x.id)} className="rounded-md border border-border p-3 space-y-2">
              <div className="flex items-center gap-2"><span className="font-medium text-[13px] flex-1">{String(x.name)}</span><Badge>{String(x.scope)}</Badge>{r && <Badge tone={r.balanced ? "ok" : "bad"} title={`reserved diff ${r.reserved_diff}, spent diff ${r.spent_diff}`}>{r.balanced ? "reconciled" : "mismatch"}</Badge>}</div>
              <BudgetBar b={x as unknown as Record<string, number>} />
              <div className="text-[11px] text-muted">{fmt.day(x.period_start)} – {fmt.day(x.period_end)}{x.daily_limit ? ` · daily limit ${fmt.money(x.daily_limit)}` : ""}{x.offer_id ? ` · ${offers.find((o) => o.id === x.offer_id)?.name ?? x.offer_id}` : ""}</div>
            </div>);
        })}</div>}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="New budget" footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" disabled={!f.name} onClick={create}>Create</Button></>}>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2"><Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field></div>
          <Field label="Scope"><Select value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })} options={["offer", "campaign", "daily", "total"]} /></Field>
          <Field label="Offer"><Select value={f.offer_id} onChange={(e) => setF({ ...f, offer_id: e.target.value })} options={[{ value: "", label: "—" }, ...offers.map((o) => ({ value: o.id, label: o.name }))]} /></Field>
          <Field label="Total (PHP)"><Input type="number" value={f.total} onChange={(e) => setF({ ...f, total: e.target.value })} /></Field>
          <Field label="Daily limit (optional)"><Input type="number" value={f.daily_limit} onChange={(e) => setF({ ...f, daily_limit: e.target.value })} /></Field>
          <Field label="Period (days)"><Input type="number" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} /></Field>
        </div>
      </Modal>
    </div>
  );
}

const NEXT: Record<string, string[]> = { issued: ["claimed", "expired", "cancelled", "reversed"], claimed: ["redeemed", "expired", "reversed"], redeemed: ["reversed"] };
function Transactions({ offers }: { offers: Offer[] }) {
  const [offer, setOffer] = useState(""); const [status, setStatus] = useState("");
  const tx = useApi<Array<Record<string, unknown>>>(`offers/transactions${offer ? `?offer=${offer}` : ""}`);
  const [sel, setSel] = useState<Record<string, unknown> | null>(null); const [to, setTo] = useState<string | null>(null);
  const { me, toast } = useGlobal(); const err = useErr();
  const rows = (tx.data ?? []).filter((r) => !status || r.status === status);
  const doTransition = async () => {
    try { await api(`offers/transactions/${sel!.id}`, { body: { to } }); toast({ kind: "success", title: `Moved to ${to}` }); tx.refresh(); setSel(null); }
    catch (e) { err(e, "Transition failed"); }
    setTo(null);
  };
  return (
    <div className="space-y-3">
      <Notice>Lifecycle: <b>Draft → Approved → Reserved → Issued → Claimed → Redeemed → Expired / Cancelled / Reversed</b>. Issuance is idempotent (unique idempotency key per batch & player plus per-user limits), so retries never double-issue. Wallets are mock.</Notice>
      <Card title="Entitlement transactions" actions={<><Select value={offer} onChange={(e) => setOffer(e.target.value)} options={[{ value: "", label: "All offers" }, ...offers.map((o) => ({ value: o.id, label: o.name }))]} className="max-w-48" /><Select value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: "", label: "All statuses" }, "issued", "claimed", "redeemed", "expired", "cancelled", "reversed"]} /></>} pad={false}>
        <div className="p-3">{tx.loading && !tx.data ? <Loading /> : <DataTable rows={rows} exportName="offer-transactions" search={(r) => `${r.player_id} ${r.offer} ${r.idempotency_key}`} onRow={setSel} cols={[
          { key: "id", label: "Transaction", render: (r) => <code className="font-mono text-[11px]">{String(r.id)}</code> },
          { key: "player_id", label: "Player" }, { key: "offer", label: "Offer" },
          { key: "amount", label: "Amount", align: "right", render: (r) => fmt.money(r.amount) },
          { key: "status", label: "Status", render: (r) => <Status value={String(r.status)} /> },
          { key: "expires_at", label: "Expires", render: (r) => fmt.day(r.expires_at) },
          { key: "updated_at", label: "Updated", render: (r) => fmt.ago(r.updated_at) },
        ]} />}</div>
      </Card>
      <Drawer open={!!sel} onClose={() => setSel(null)} title={`Transaction ${sel?.id ?? ""}`} width={500}>
        {sel && <div className="space-y-4">
          <KV items={[["Player", String(sel.player_id)], ["Offer", String(sel.offer)], ["Amount", fmt.money(sel.amount)], ["Status", <Status key="s" value={String(sel.status)} />], ["Idempotency key", <code key="k" className="font-mono text-[11px]">{String(sel.idempotency_key)}</code>], ["Budget", String(sel.budget_id ?? "–")], ["Expires", fmt.date(sel.expires_at)]]} />
          {can(me, "offers.issue") && (NEXT[String(sel.status)] ?? []).length > 0 && <div className="flex flex-wrap gap-2">{NEXT[String(sel.status)].map((s) => <Button key={s} size="sm" variant={s === "reversed" || s === "cancelled" ? "danger" : "default"} onClick={() => setTo(s)}>Mark {s}</Button>)}</div>}
          <div><div className="text-xs font-semibold mb-1">History</div><JsonView value={parseMaybe(sel.history, [])} /></div>
        </div>}
      </Drawer>
      <Confirm open={!!to} onClose={() => setTo(null)} onConfirm={doTransition} danger={to === "reversed" || to === "cancelled"} title={`Move to ${to}?`} confirmLabel={`Mark ${to}`} body="Budget reservation/spend is adjusted atomically and the change is audited." />
    </div>
  );
}

function Analytics() {
  const a = useApi<{ distribution: Array<{ name: string; outcome: string; n: number }>; lifecycle: Array<{ name: string; status: string; n: number; amount: number }>; fairness: Array<{ vip_tier: string; outcome: string; n: number }>; budgets: Array<Record<string, number | string>>; duplicates: { n: number } }>("offers/analytics");
  if (a.loading && !a.data) return <Loading rows={6} />;
  if (!a.data) return <ErrorState error={a.error} onRetry={a.refresh} />;
  const d = a.data;
  const offerNames = [...new Set(d.distribution.map((x) => x.name))];
  const outs = ["none", "reduced", "standard", "enhanced"];
  const lcNames = [...new Set(d.lifecycle.map((x) => x.name))]; const statuses = ["issued", "claimed", "redeemed", "expired", "cancelled", "reversed"];
  const tiers = ["standard", "bronze", "silver", "gold", "platinum"];
  const fair = (t: string, o: string) => d.fairness.find((x) => x.vip_tier === t && x.outcome === o)?.n ?? 0;
  const tierTot = (t: string) => outs.reduce((s, o) => s + fair(t, o), 0);
  const totalIssued = d.lifecycle.reduce((s, x) => s + x.n, 0);
  const st = (s: string) => d.lifecycle.filter((x) => x.status === s).reduce((a2, x) => a2 + x.n, 0);
  const budgetUsed = d.budgets.reduce((s, b) => s + Number(b.reserved) + Number(b.spent), 0), budgetTot = d.budgets.reduce((s, b) => s + Number(b.total), 0);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
        <Stat label="Decisions (non-sim)" value={d.distribution.reduce((s, x) => s + x.n, 0)} format={fmt.int} />
        <Stat label="Eligible" value={d.distribution.filter((x) => x.outcome !== "none").reduce((s, x) => s + x.n, 0)} format={fmt.int} />
        <Stat label="Issued" value={totalIssued} format={fmt.int} />
        <Stat label="Claimed / redeemed" value={`${fmt.int(st("claimed") + st("redeemed"))} / ${fmt.int(st("redeemed"))}`} />
        <Stat label="Budget utilization" value={budgetTot ? budgetUsed / budgetTot : 0} format={(v) => fmt.pct(v)} />
        <Stat label="Duplicates prevented" value={d.duplicates?.n ?? 0} format={fmt.int} />
      </div>
      <div className="grid lg:grid-cols-2 gap-3">
        <Card title="Decision distribution by offer">{offerNames.length ? <Chart height={260} option={bar(offerNames, outs.map((o) => ({ name: o, data: offerNames.map((n) => d.distribution.find((x) => x.name === n && x.outcome === o)?.n ?? 0) })), { stack: true })} /> : <Empty body="No non-simulated decisions yet." />}</Card>
        <Card title="Lifecycle by offer">{lcNames.length ? <Chart height={260} option={bar(lcNames, statuses.map((s) => ({ name: s, data: lcNames.map((n) => d.lifecycle.find((x) => x.name === n && x.status === s)?.n ?? 0) })), { stack: true })} /> : <Empty />}</Card>
      </div>
      <Card title="Entitlement fairness — outcome share by membership tier" subtitle="Equal treatment check: players with the same tier and tenure should receive the same outcome; differences should be explained only by approved rules">
        <div className="overflow-x-auto"><table className="text-[12.5px] w-full"><thead className="text-muted"><tr><th className="text-left px-2 py-1.5">Tier</th>{outs.map((o) => <th key={o} className="px-2 py-1.5 text-right">{o}</th>)}<th className="px-2 py-1.5 text-right">n</th></tr></thead>
          <tbody>{tiers.map((t) => { const tot = tierTot(t); return <tr key={t} className="border-t border-border"><td className="px-2 py-1.5 font-medium">{t}</td>{outs.map((o) => { const v = tot ? fair(t, o) / tot : 0; return <td key={o} className="px-2 py-1.5 text-right tabular-nums" style={{ background: `color-mix(in srgb, var(--accent) ${Math.round(v * 60)}%, transparent)` }}>{tot ? fmt.pct(v, 0) : "–"}</td>; })}<td className="px-2 py-1.5 text-right text-muted">{tot}</td></tr>; })}</tbody></table></div>
        <div className="text-[11px] text-muted mt-2">Fairness here means consistency with documented rules. Tier and tenure are the only personalization inputs; gaming and financial behaviour are excluded by policy.</div>
      </Card>
      <Card title="Budgets"><div className="grid md:grid-cols-2 gap-3">{d.budgets.map((b) => <div key={String(b.id)}><div className="text-xs font-medium mb-1">{String(b.name)}</div><BudgetBar b={b as Record<string, number>} /></div>)}</div></Card>
    </div>
  );
}

export default function Page() { return <Suspense fallback={<Loading />}><OffersInner /></Suspense>; }
