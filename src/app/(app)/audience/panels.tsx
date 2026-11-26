"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, RefreshCw, Sparkles, Wand2 } from "lucide-react";
import { api, can, downloadCsv, fmt, useApi, useGlobal } from "@/components/hooks";
import { Badge, Button, Card, Confirm, DataTable, Drawer, Empty, ErrorState, Field, Input, JsonView, KV, Loading, Modal, Notice, Select, Stat, Status, Textarea } from "@/components/ui";
import { Chart, bar, pie } from "@/components/chart";
import type { Rule } from "./builder";

type KN = { k: string | null; n: number };
const kn = (rows: KN[] | undefined) => (rows ?? []).map((r) => ({ name: String(r.k ?? "unknown"), value: r.n }));

// ───────── overview ─────────
export function OverviewTab() {
  const o = useApi<{ lifecycle: KN[]; kyc: KN[]; tiers: KN[]; platforms: KN[]; completeness: KN[]; consent: Array<{ channel: string; purpose: string; granted: number; n: number }>; totals: { customers: number; protected: number }; categories: KN[] }>("audience/overview");
  const router = useRouter();
  const d = o.data;
  const sum = (rows: KN[] | undefined, k: string) => rows?.find((r) => r.k === k)?.n ?? 0;
  const total = d?.totals.customers ?? 0;
  const consent = useMemo(() => {
    const m = new Map<string, { channel: string; service: number; marketing: number; n: number }>();
    for (const c of d?.consent ?? []) { const x = m.get(c.channel) ?? { channel: c.channel, service: 0, marketing: 0, n: c.n }; x[c.purpose as "service" | "marketing"] = c.granted; m.set(c.channel, x); }
    return [...m.values()];
  }, [d]);
  if (o.error) return <ErrorState error={o.error} onRetry={o.refresh} />;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <Stat label="Profiles" value={total} format={fmt.int} loading={!d} />
        <Stat label="KYC verified" value={total ? sum(d?.kyc, "verified") / total : null} format={(v) => fmt.pct(v)} loading={!d} hint="verified / all profiles" />
        <Stat label="Active / engaged" value={sum(d?.lifecycle, "active") + sum(d?.lifecycle, "engaged")} format={fmt.int} loading={!d} />
        <Stat label="At risk / dormant" value={sum(d?.lifecycle, "at_risk") + sum(d?.lifecycle, "dormant")} format={fmt.int} loading={!d} />
        <Stat label="Under RG protection" value={d?.totals.protected} format={fmt.int} loading={!d} hint="Self-excluded or RG-restricted — excluded from all promotions" />
      </div>
      <div className="grid lg:grid-cols-3 gap-3">
        <Card title="Lifecycle stages">{d ? <Chart height={220} option={pie(kn(d.lifecycle))} onClick={(p) => router.push(`/audience?tab=explorer&lifecycle_stage=${p.name}`)} /> : <Loading />}</Card>
        <Card title="KYC status">{d ? <Chart height={220} option={pie(kn(d.kyc))} onClick={(p) => router.push(`/audience?tab=explorer&kyc_status=${p.name}`)} /> : <Loading />}</Card>
        <Card title="Membership tiers">{d ? <Chart height={220} option={bar(kn(d.tiers).map((x) => x.name), [{ name: "Players", data: kn(d.tiers).map((x) => x.value) }])} /> : <Loading />}</Card>
        <Card title="Primary platform">{d ? <Chart height={220} option={pie(kn(d.platforms))} /> : <Loading />}</Card>
        <Card title="Profile completeness" subtitle="% of populated profile fields">{d ? <Chart height={220} option={bar(d.completeness.map((x) => `${x.k}%`), [{ name: "Profiles", data: d.completeness.map((x) => x.n) }])} /> : <Loading />}</Card>
        <Card title="Favourite game category">{d ? <Chart height={220} option={bar(kn(d.categories).map((x) => x.name), [{ name: "Players", data: kn(d.categories).map((x) => x.value) }], { horizontal: true })} /> : <Loading />}</Card>
      </div>
      <Card title="Channel consent coverage" subtitle="Granted consents per channel and purpose (service vs marketing)">
        <DataTable dense rows={consent as unknown as Record<string, unknown>[]} rowKey={(r) => String(r.channel)} exportName="consent-coverage" cols={[
          { key: "channel", label: "Channel", render: (r) => <span className="font-medium">{String(r.channel)}</span> },
          { key: "service", label: "Service consent", align: "right", render: (r) => <>{fmt.int(r.service)} <span className="text-faint">({fmt.pct(Number(r.service) / Number(r.n))})</span></> },
          { key: "marketing", label: "Marketing consent", align: "right", render: (r) => <>{fmt.int(r.marketing)} <span className="text-faint">({fmt.pct(Number(r.marketing) / Number(r.n))})</span></> },
        ]} />
      </Card>
    </div>
  );
}

// ───────── explorer ─────────
type Row = Record<string, unknown>;
export function ExplorerTab({ initial }: { initial: Record<string, string> }) {
  const router = useRouter();
  const [f, setF] = useState({ q: "", lifecycle_stage: "", kyc_status: "", vip_tier: "", primary_platform: "", os: "", segment: "", sort: "last_active_at", dir: "desc", ...initial });
  const [page, setPage] = useState(0); const size = 50;
  const [q, setQ] = useState(f.q);
  useEffect(() => { const t = setTimeout(() => setF((x) => ({ ...x, q })), 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => setPage(0), [f]);
  const qs = useMemo(() => { const p = new URLSearchParams({ limit: String(size), offset: String(page * size) }); for (const [k, v] of Object.entries(f)) if (v) p.set(k, v); return p.toString(); }, [f, page]);
  const res = useApi<{ total: number; rows: Row[] }>(`customers?${qs}`);
  const segs = useApi<Array<{ id: string; name: string }>>("segments");
  const sel = (k: keyof typeof f, label: string, opts: string[]) => <Select aria-label={label} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} options={[{ value: "", label }, ...opts]} />;
  const pages = Math.max(1, Math.ceil((res.data?.total ?? 0) / size));
  return (
    <Card title="User Explorer" subtitle={res.data ? `${fmt.int(res.data.total)} matching profiles · PII masked according to your role` : " "} actions={<Button size="sm" variant="ghost" onClick={() => res.data && downloadCsv("customers", res.data.rows)}><Download size={13} />Export page</Button>}>
      <div className="flex flex-wrap gap-2 mb-3">
        <Input placeholder="Search player id / name / email" value={q} onChange={(e) => setQ(e.target.value)} className="w-64" aria-label="Search" />
        {sel("lifecycle_stage", "Lifecycle", ["new", "active", "engaged", "at_risk", "dormant", "churned"])}
        {sel("kyc_status", "KYC", ["not_started", "pending", "in_review", "failed", "verified"])}
        {sel("vip_tier", "Tier", ["standard", "bronze", "silver", "gold", "platinum"])}
        {sel("primary_platform", "Platform", ["app", "h5", "pc"])}
        {sel("os", "OS", ["android", "ios", "windows", "macos"])}
        <Select aria-label="Segment" value={f.segment} onChange={(e) => setF({ ...f, segment: e.target.value })} options={[{ value: "", label: "Any segment" }, ...(segs.data ?? []).map((s) => ({ value: s.id, label: s.name }))]} className="max-w-48" />
        <Select aria-label="Sort" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} options={[{ value: "last_active_at", label: "Last active" }, { value: "registered_at", label: "Registered" }, { value: "launch_failures_7d", label: "Launch failures" }, { value: "open_tickets", label: "Open tickets" }, { value: "profile_completeness", label: "Completeness" }]} />
        <Select aria-label="Direction" value={f.dir} onChange={(e) => setF({ ...f, dir: e.target.value })} options={[{ value: "desc", label: "desc" }, { value: "asc", label: "asc" }]} />
      </div>
      <ErrorState error={res.error} onRetry={res.refresh} />
      {res.loading && !res.data ? <Loading rows={8} /> : (
        <DataTable rows={res.data?.rows ?? []} pageSize={size} onRow={(r) => router.push(`/audience/${r.player_id}`)} cols={[
          { key: "player_id", label: "Player", render: (r) => <span className="font-mono">{String(r.player_id)}</span> },
          { key: "display_name", label: "Name" }, { key: "email", label: "Email", className: "max-w-48 truncate" },
          { key: "lifecycle_stage", label: "Stage", render: (r) => <Status value={String(r.lifecycle_stage)} /> },
          { key: "kyc_status", label: "KYC", render: (r) => <Status value={String(r.kyc_status)} /> },
          { key: "vip_tier", label: "Tier" }, { key: "primary_platform", label: "Platform", render: (r) => `${r.primary_platform} · ${r.os}` },
          { key: "launch_failures_7d", label: "Launch fails 7d", align: "right" }, { key: "open_tickets", label: "Open tickets", align: "right" },
          { key: "flags", label: "Flags", render: (r) => (r.self_excluded || r.rg_restricted ? <Badge tone="bad">RG protected</Badge> : null) },
          { key: "last_active_at", label: "Last active", render: (r) => fmt.ago(r.last_active_at) },
        ]} />
      )}
      <div className="flex items-center justify-end gap-2 mt-2 text-xs text-muted">
        <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>Prev</Button><span>Page {page + 1} / {pages}</span><Button size="sm" variant="ghost" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next</Button>
      </div>
    </Card>
  );
}

// ───────── gaming intelligence ─────────
export function GamingTab() {
  const { days } = useGlobal();
  const g = useApi<{ funnel: Array<{ step: string; players: number }>; byEntry: Array<{ k: string; clicks: number }>; errors: KN[]; byOs: Array<{ k: string; fail: number; n: number; load: number }>; categories: Array<{ k: string; sessions: number }>; topGames: Row[]; searches: Array<{ k: string; none: number; n: number }>; providers: Array<{ id: string; name: string; launches: number; failures: number; avg_load: number }> }>(`gaming/intelligence?days=${days}`);
  if (g.error) return <ErrorState error={g.error} onRetry={g.refresh} />;
  const d = g.data;
  if (!d) return <Loading rows={8} />;
  return (
    <div className="space-y-3">
      <Notice>Gaming Intelligence uses experience, discovery and preference signals only. Restricted betting, turnover and win/loss records are not shown here and are never used to increase incentives.</Notice>
      <div className="grid lg:grid-cols-2 gap-3">
        <Card title="Gaming experience funnel" subtitle={`Distinct players · last ${days}d`}><Chart height={240} option={bar(d.funnel.map((s) => s.step.replace("game_", "")), [{ name: "Players", data: d.funnel.map((s) => s.players) }])} /></Card>
        <Card title="Game discovery: entry sources"><Chart height={240} option={pie(d.byEntry.map((e) => ({ name: e.k ?? "unknown", value: e.clicks })))} /></Card>
        <Card title="Launch failures by error code"><Chart height={240} option={bar(kn(d.errors).map((x) => x.name), [{ name: "Failures", data: kn(d.errors).map((x) => x.value) }], { horizontal: true })} /></Card>
        <Card title="Experience by OS" pad={false}><div className="p-3"><DataTable dense rows={d.byOs as unknown as Row[]} rowKey={(r) => String(r.k)} cols={[
          { key: "k", label: "OS" }, { key: "n", label: "Launches", align: "right", render: (r) => fmt.int(r.n) },
          { key: "fr", label: "Failure rate", align: "right", sort: (r) => Number(r.fail) / Number(r.n), render: (r) => fmt.pct(Number(r.fail) / Math.max(1, Number(r.n))) },
          { key: "load", label: "Avg load", align: "right", render: (r) => fmt.ms(r.load) }]} /></div></Card>
        <Card title="Sessions by category"><Chart height={240} option={bar(d.categories.map((c) => c.k), [{ name: "Sessions", data: d.categories.map((c) => c.sessions) }])} /></Card>
        <Card title="Search keywords" pad={false}><div className="p-3"><DataTable dense rows={d.searches as unknown as Row[]} rowKey={(r) => String(r.k)} cols={[
          { key: "k", label: "Keyword" }, { key: "n", label: "Searches", align: "right" }, { key: "none", label: "No result", align: "right" },
          { key: "nr", label: "No-result rate", align: "right", sort: (r) => Number(r.none) / Number(r.n), render: (r) => { const v = Number(r.none) / Math.max(1, Number(r.n)); return <span className={v > 0.5 ? "text-bad" : ""}>{fmt.pct(v)}</span>; } }]} /></div></Card>
      </div>
      <Card title="Top games" pad={false}><div className="p-3"><DataTable dense rows={d.topGames} rowKey={(r) => String(r.name)} cols={[{ key: "name", label: "Game" }, { key: "provider", label: "Provider" }, { key: "sessions", label: "Sessions", align: "right" }]} /></div></Card>
      <Card title="Provider performance" pad={false}><div className="p-3"><DataTable dense rows={d.providers as unknown as Row[]} exportName="provider-performance" cols={[
        { key: "name", label: "Provider" }, { key: "launches", label: "Launches", align: "right", render: (r) => fmt.int(r.launches) }, { key: "failures", label: "Failures", align: "right" },
        { key: "fr", label: "Failure rate", align: "right", sort: (r) => Number(r.failures) / Number(r.launches), render: (r) => { const v = Number(r.failures) / Math.max(1, Number(r.launches)); return <span className={v > 0.1 ? "text-bad font-medium" : ""}>{fmt.pct(v)}</span>; } },
        { key: "avg_load", label: "Avg load", align: "right", render: (r) => fmt.ms(r.avg_load) }]} /></div></Card>
    </div>
  );
}

// ───────── identity ─────────
export function IdentityTab() {
  const { me, toast } = useGlobal();
  const stats = useApi<Array<{ identity_type: string; n: number; verified: number }>>("identities/stats");
  const cands = useApi<Row[]>("identities/candidates");
  const [type, setType] = useState("email"); const [value, setValue] = useState(""); const [found, setFound] = useState<{ player_id: string | null; verified?: number } | null>(null);
  const [decide, setDecide] = useState<{ id: string; approve: boolean } | null>(null); const [busy, setBusy] = useState(false);
  const allowed = can(me, "identity.merge");
  return (
    <div className="space-y-3">
      <Notice>Identity resolution uses Player ID as the primary key and links only <b>verified</b> identifiers automatically. Uncertain matches are <b>never auto-merged</b> — they enter the review queue below with a full audit trail.</Notice>
      <div className="grid lg:grid-cols-3 gap-3">
        <Card title="Linked identities by type" className="lg:col-span-2">{stats.data ? <Chart height={240} option={bar(stats.data.map((s) => s.identity_type), [{ name: "Verified", data: stats.data.map((s) => s.verified) }, { name: "Unverified", data: stats.data.map((s) => s.n - s.verified) }], { stack: true })} /> : <Loading />}</Card>
        <Card title="Resolve an identifier">
          <div className="space-y-2">
            <Field label="Type"><Select value={type} onChange={(e) => setType(e.target.value)} options={["player_id", "email", "phone", "app_device", "h5_cookie", "pc_cookie", "sso", "messenger", "whatsapp", "viber", "telegram"]} /></Field>
            <Field label="Value"><Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. P100005" /></Field>
            <Button variant="primary" onClick={async () => setFound(await api(`identities/resolve?type=${encodeURIComponent(type)}&value=${encodeURIComponent(value)}`))} disabled={!value}>Resolve</Button>
            {found && (found.player_id ? <div className="text-[13px]">→ <a className="text-accent font-mono" href={`/audience/${found.player_id}`}>{found.player_id}</a> {found.verified ? <Badge tone="ok">verified</Badge> : <Badge tone="warn">unverified</Badge>}</div> : <div className="text-xs text-muted">No linked profile.</div>)}
          </div>
        </Card>
      </div>
      <Card title="Merge review queue" subtitle={allowed ? "Approve only when evidence confirms the same person" : "Read-only — requires identity.merge"}>
        {cands.data ? <DataTable rows={cands.data} exportName="identity-candidates" cols={[
          { key: "identity_type", label: "Identifier" }, { key: "identity_value", label: "Value", className: "font-mono" },
          { key: "candidate_player_id", label: "Candidate", render: (r) => <a className="text-accent font-mono" href={`/audience/${r.candidate_player_id}`}>{String(r.candidate_player_id)}</a> },
          { key: "matched_player_id", label: "Conflicts with", render: (r) => r.matched_player_id ? <a className="text-accent font-mono" href={`/audience/${r.matched_player_id}`}>{String(r.matched_player_id)}</a> : "–" },
          { key: "match_reason", label: "Reason" }, { key: "confidence", label: "Confidence", align: "right", render: (r) => fmt.pct(r.confidence, 0) },
          { key: "status", label: "Status", render: (r) => <Status value={String(r.status)} /> },
          { key: "act", label: "", render: (r) => r.status === "pending" && allowed ? <div className="flex gap-1"><Button size="sm" onClick={() => setDecide({ id: String(r.id), approve: true })}>Merge</Button><Button size="sm" variant="ghost" onClick={() => setDecide({ id: String(r.id), approve: false })}>Reject</Button></div> : null },
        ]} /> : <Loading />}
      </Card>
      <Confirm open={!!decide} onClose={() => setDecide(null)} loading={busy} danger={decide?.approve} title={decide?.approve ? "Merge identity?" : "Reject match?"} confirmLabel={decide?.approve ? "Link identity" : "Reject"}
        body={decide?.approve ? "The identifier will be linked to the candidate player (and removed from any conflicting profile). This is recorded in the merge audit trail." : "The candidate will be marked rejected; no profiles change."}
        onConfirm={async () => { setBusy(true); try { await api(`identities/candidates/${decide!.id}`, { body: { approve: decide!.approve } }); toast({ kind: "success", title: "Decision recorded" }); cands.refresh(); stats.refresh(); } catch (e) { toast({ kind: "error", title: (e as Error).message }); } setBusy(false); setDecide(null); }} />
    </div>
  );
}

// ───────── tags ─────────
export function TagsTab() {
  const { me, toast } = useGlobal();
  const tags = useApi<Row[]>("tags");
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ key: "", name: "", tag_type: "manual", description: "", expires_after_days: "", refresh_policy: "manual", usage_restriction: "" });
  const types = ["manual", "system", "event", "computed", "temporary", "ai_suggested", ...(can(me, "compliance.write") ? ["compliance"] : [])];
  const create = async () => {
    setBusy(true);
    try { await api("tags", { body: { ...f, expires_after_days: f.expires_after_days ? Number(f.expires_after_days) : undefined, description: f.description || undefined, usage_restriction: f.usage_restriction || undefined } }); toast({ kind: "success", title: "Tag created" }); setOpen(false); tags.refresh(); }
    catch (e) { toast({ kind: "error", title: "Could not create tag", body: (e as Error).message }); }
    setBusy(false);
  };
  return (
    <Card title="Tag management" subtitle="Manual, system, event-based, computed, temporary, AI-suggested and compliance tags" actions={can(me, "tags.write") && <Button size="sm" variant="primary" onClick={() => setOpen(true)}>New tag</Button>}>
      {tags.data ? <DataTable rows={tags.data} search={(r) => `${r.key} ${r.name}`} exportName="tags" cols={[
        { key: "name", label: "Tag", render: (r) => <div><div className="font-medium">{String(r.name)}</div><div className="font-mono text-[11px] text-faint">{String(r.key)}</div></div> },
        { key: "tag_type", label: "Type", render: (r) => <Badge tone={r.tag_type === "compliance" ? "bad" : r.tag_type === "ai_suggested" ? "accent" : "neutral"}>{String(r.tag_type)}</Badge> },
        { key: "description", label: "Source / rule", className: "max-w-64 truncate" }, { key: "owner", label: "Owner" },
        { key: "refresh_policy", label: "Refresh" }, { key: "expires_after_days", label: "Expiry", render: (r) => (r.expires_after_days ? `${r.expires_after_days}d` : "none") },
        { key: "usage_restriction", label: "Restriction", render: (r) => r.usage_restriction ? <span className="text-warn text-xs">{String(r.usage_restriction)}</span> : "–" },
        { key: "members", label: "Members", align: "right", render: (r) => fmt.int(r.members) }, { key: "created_at", label: "Created", render: (r) => fmt.day(r.created_at) },
      ]} /> : <Loading />}
      <Modal open={open} onClose={() => setOpen(false)} title="New tag" footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={create} disabled={!f.key || !f.name}>Create</Button></>}>
        <div className="grid gap-2">
          <Field label="Key" hint="lowercase, digits, underscore"><Input value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} /></Field>
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Type"><Select value={f.tag_type} onChange={(e) => setF({ ...f, tag_type: e.target.value })} options={types} /></Field>
            <Field label="Refresh policy"><Select value={f.refresh_policy} onChange={(e) => setF({ ...f, refresh_policy: e.target.value })} options={["manual", "realtime", "hourly", "daily"]} /></Field>
          </div>
          <Field label="Description / source"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Expires after (days)"><Input type="number" value={f.expires_after_days} onChange={(e) => setF({ ...f, expires_after_days: e.target.value })} /></Field>
            <Field label="Usage restriction"><Input value={f.usage_restriction} onChange={(e) => setF({ ...f, usage_restriction: e.target.value })} placeholder="e.g. exclusion use only" /></Field>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

// ───────── segments ─────────
type Seg = { id: string; name: string; description: string | null; segment_type: string; purpose: string; version: number; status: string; member_count: number; refresh_schedule: string | null; last_evaluated_at: string | null; ai_generated: number; rules: Rule; description_rules: string; updated_at: string };
export function SegmentsTab({ openId, onOpen, onEditInBuilder }: { openId: string | null; onOpen: (id: string | null) => void; onEditInBuilder: (r: Rule, segId: string) => void }) {
  const segs = useApi<Seg[]>("segments");
  const [pick, setPick] = useState<string[]>([]);
  const ov = useApi<Array<{ a: string; b: string; overlap: number }>>(pick.length >= 2 ? `segments/overlap?ids=${pick.join(",")}` : null, [pick.join(",")]);
  const name = (id: string) => segs.data?.find((s) => s.id === id)?.name ?? id;
  const size = (id: string) => segs.data?.find((s) => s.id === id)?.member_count ?? 0;
  return (
    <div className="space-y-3">
      <Card title="Segments" subtitle="Select up to 6 rows (checkbox) for overlap analysis">
        <ErrorState error={segs.error} onRetry={segs.refresh} />
        {segs.data ? <DataTable rows={segs.data as unknown as Row[]} search={(r) => String(r.name)} exportName="segments" onRow={(r) => onOpen(String(r.id))} cols={[
          { key: "pick", label: "", render: (r) => <input type="checkbox" aria-label={`Select ${r.name}`} checked={pick.includes(String(r.id))} onClick={(e) => e.stopPropagation()} onChange={(e) => setPick((p) => e.target.checked ? [...p, String(r.id)].slice(-6) : p.filter((x) => x !== r.id))} /> },
          { key: "name", label: "Segment", render: (r) => <div className="flex items-center gap-1.5"><span className="font-medium">{String(r.name)}</span>{r.ai_generated ? <Badge tone="accent"><Sparkles size={10} />AI</Badge> : null}</div> },
          { key: "segment_type", label: "Type", render: (r) => <Badge>{String(r.segment_type)}</Badge> },
          { key: "purpose", label: "Purpose", render: (r) => <Badge tone={["marketing", "membership"].includes(String(r.purpose)) ? "warn" : "info"}>{String(r.purpose)}</Badge> },
          { key: "member_count", label: "Members", align: "right", render: (r) => fmt.int(r.member_count) }, { key: "version", label: "Ver", align: "right", render: (r) => `v${r.version}` },
          { key: "refresh_schedule", label: "Refresh", render: (r) => String(r.refresh_schedule ?? "frozen") }, { key: "status", label: "Status", render: (r) => <Status value={String(r.status)} /> },
          { key: "last_evaluated_at", label: "Evaluated", render: (r) => fmt.ago(r.last_evaluated_at) },
        ]} /> : <Loading rows={8} />}
      </Card>
      {pick.length >= 2 && <Card title="Segment overlap" subtitle="Shared members between selected segments (share of smaller segment)">
        {ov.data ? <div className="overflow-x-auto scroll-thin"><table className="text-[12px]"><thead><tr><th />{pick.map((id) => <th key={id} className="px-2 py-1 font-medium text-muted max-w-32 truncate">{name(id)}</th>)}</tr></thead>
          <tbody>{pick.map((a) => <tr key={a}><th className="px-2 py-1 text-left font-medium text-muted max-w-40 truncate">{name(a)}</th>{pick.map((b) => {
            if (a === b) return <td key={b} className="px-2 py-1 text-center text-faint">{fmt.int(size(a))}</td>;
            const o = ov.data!.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a))?.overlap ?? 0;
            const share = o / Math.max(1, Math.min(size(a), size(b)));
            return <td key={b} className="px-2 py-1 text-center tabular-nums" style={{ background: `rgba(99,102,241,${Math.min(0.75, share)})` }} title={`${fmt.pct(share)} of smaller`}>{fmt.int(o)}</td>;
          })}</tr>)}</tbody></table></div> : <Loading />}
      </Card>}
      <SegmentDrawer id={openId} onClose={() => onOpen(null)} onChanged={segs.refresh} onEditInBuilder={onEditInBuilder} />
    </div>
  );
}

function SegmentDrawer({ id, onClose, onChanged, onEditInBuilder }: { id: string | null; onClose: () => void; onChanged: () => void; onEditInBuilder: (r: Rule, segId: string) => void }) {
  const { me, toast } = useGlobal();
  const d = useApi<{ segment: Seg; members: Row[]; versions: Row[]; history: Row[]; daily: Array<{ d: string; entered: number; exited: number }> }>(id ? `segments/${id}` : null);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, msg: string) => { setBusy(true); try { await fn(); toast({ kind: "success", title: msg }); d.refresh(); onChanged(); } catch (e) { toast({ kind: "error", title: (e as Error).message }); } setBusy(false); };
  const s = d.data?.segment;
  const w = can(me, "segments.write");
  return (
    <Drawer open={!!id} onClose={onClose} title={s?.name ?? "Segment"} width={680} footer={s && w ? <>
      <Button onClick={() => act(async () => { const r = await api<{ entered: number; exited: number; size: number }>(`segments/${s.id}/evaluate`, { body: {} }); toast({ kind: "info", title: `+${r.entered} / −${r.exited}`, body: `${r.size} members` }); }, "Re-evaluated")} loading={busy}><RefreshCw size={13} />Re-evaluate</Button>
      <Button onClick={() => onEditInBuilder(s.rules, s.id)}><Wand2 size={13} />Edit rules</Button>
      <Button onClick={() => act(() => api(`segments/${s.id}/status`, { body: { status: s.status === "paused" ? "active" : "paused" } }), "Status updated")}>{s.status === "paused" ? "Resume" : "Pause"}</Button>
      <Button variant="ghost" onClick={() => act(() => api(`segments/${s.id}/status`, { body: { status: "archived" } }), "Archived")}>Archive</Button>
    </> : undefined}>
      {!d.data ? <Loading rows={6} /> : s && <div className="space-y-4">
        <div className="flex flex-wrap gap-1.5"><Badge>{s.segment_type}</Badge><Badge tone="info">{s.purpose}</Badge><Status value={s.status} /><Badge>v{s.version}</Badge>{s.ai_generated ? <Badge tone="accent">AI-generated</Badge> : null}</div>
        <KV items={[["Members", fmt.int(s.member_count)], ["Description", s.description ?? "–"], ["Rules", <code key="r" className="font-mono text-[11.5px]">{s.description_rules}</code>], ["Refresh", s.refresh_schedule ?? "frozen (static)"], ["Last evaluated", fmt.date(s.last_evaluated_at)]]} />
        {d.data.daily.length > 0 && <Card title="Membership changes"><Chart height={180} option={bar(d.data.daily.map((x) => x.d.slice(5)), [{ name: "Entered", data: d.data.daily.map((x) => x.entered) }, { name: "Exited", data: d.data.daily.map((x) => -x.exited) }], { stack: true })} /></Card>}
        <div><div className="text-xs font-semibold text-muted mb-1">Sample members</div><DataTable dense pageSize={10} rows={d.data.members} cols={[{ key: "player_id", label: "Player", render: (r) => <a className="text-accent font-mono" href={`/audience/${r.player_id}`}>{String(r.player_id)}</a> }, { key: "display_name", label: "Name" }, { key: "kyc_status", label: "KYC" }, { key: "vip_tier", label: "Tier" }, { key: "joined_at", label: "Joined", render: (r) => fmt.ago(r.joined_at) }]} /></div>
        <div><div className="text-xs font-semibold text-muted mb-1">Membership history</div><DataTable dense pageSize={10} rows={d.data.history} cols={[{ key: "player_id", label: "Player", className: "font-mono" }, { key: "action", label: "Action", render: (r) => <Badge tone={r.action === "enter" ? "ok" : "warn"}>{String(r.action)}</Badge> }, { key: "reason", label: "Reason" }, { key: "at", label: "At", render: (r) => fmt.date(r.at) }]} /></div>
        <div><div className="text-xs font-semibold text-muted mb-1">Versions</div><DataTable dense rows={d.data.versions} rowKey={(r) => String(r.version)} cols={[{ key: "version", label: "Version", render: (r) => `v${r.version}` }, { key: "created_by", label: "By" }, { key: "created_at", label: "At", render: (r) => fmt.date(r.created_at) }, { key: "rules", label: "Rules", className: "max-w-72 truncate font-mono text-[11px]" }]} /></div>
        <details><summary className="text-xs text-muted cursor-pointer">Rule JSON</summary><JsonView value={s.rules} /></details>
      </div>}
    </Drawer>
  );
}

// ───────── AI segment builder ─────────
type AiRes = { refused?: string; rules?: Rule; explanation?: string[]; count?: number; total?: number; share?: number; sample?: Row[]; description?: string; generated_by?: string };
export function AiTab({ onEditInBuilder, onSaved }: { onEditInBuilder: (r: Rule) => void; onSaved: (id: string) => void }) {
  const { toast } = useGlobal();
  const [text, setText] = useState("Find users who experienced game loading failures in the last seven days and have unresolved customer service tickets.");
  const [purpose, setPurpose] = useState("service");
  const [res, setRes] = useState<AiRes | null>(null); const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false); const [name, setName] = useState("");
  const gen = async () => { setBusy(true); try { const r = await api<AiRes>("segments/ai", { body: { description: text, purpose } }); setRes(r); setName(text.slice(0, 60)); } catch (e) { toast({ kind: "error", title: (e as Error).message }); } setBusy(false); };
  const save = async () => {
    try { const s = await api<{ id: string; member_count: number }>("segments", { body: { name: name || text.slice(0, 60), description: `AI-generated: ${res?.description}`, type: "dynamic", purpose, rules: res!.rules, ai_generated: true } }); toast({ kind: "success", title: "Segment saved", body: `${fmt.int(s.member_count)} members` }); onSaved(s.id); }
    catch (e) { toast({ kind: "error", title: "Save failed", body: (e as Error).message }); }
    setConfirm(false);
  };
  return (
    <div className="grid lg:grid-cols-2 gap-3">
      <Card title={<span className="flex items-center gap-1.5"><Sparkles size={14} className="text-accent" />Describe your audience</span>} subtitle="Natural language → structured rules. Nothing is saved until you confirm.">
        <div className="space-y-2">
          <Textarea rows={4} className="w-full" value={text} onChange={(e) => setText(e.target.value)} aria-label="Audience description" />
          <div className="flex items-center gap-2"><Select aria-label="Purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} options={["service", "membership", "marketing", "operational"]} /><div className="flex-1" /><Button variant="primary" onClick={gen} loading={busy} disabled={text.length < 5}><Wand2 size={13} />Generate rules</Button></div>
          <div className="text-[11px] text-faint">Requests to target losses, chasing, vulnerability or wagering intensity are refused by policy.</div>
        </div>
      </Card>
      <Card title="Generated segment">
        {!res ? <Empty title="No draft yet" body="Describe an audience and generate rules." /> : res.refused ? <Notice tone="warn">{res.refused}</Notice> : !res.rules || (res.rules.type === "group" && !res.rules.children.length) ? <Notice>Couldn&apos;t map that description to known fields. Mention KYC status, platform, OS, tier, launch failures, tickets, search, inactivity or a city.</Notice> : (
          <div className="space-y-3">
            <div className="flex items-baseline gap-2"><span className="text-[24px] font-semibold tabular-nums">{fmt.int(res.count)}</span><span className="text-xs text-muted">players ({fmt.pct(res.share)}) · <Badge tone="ok">verified count</Badge></span></div>
            <code className="block text-[11.5px] font-mono bg-panel-2 border border-border rounded p-2">{res.description}</code>
            <div><div className="text-xs font-semibold text-muted mb-1">Why these fields</div><ul className="list-disc pl-4 text-[12.5px] space-y-0.5">{res.explanation?.map((e) => <li key={e}>{e}</li>)}</ul></div>
            <div className="text-[11px] text-faint">Generated by: {res.generated_by}</div>
            <div className="text-xs font-semibold text-muted">Preview</div>
            <DataTable dense pageSize={5} rows={res.sample ?? []} cols={[{ key: "player_id", label: "Player", className: "font-mono" }, { key: "kyc_status", label: "KYC" }, { key: "launch_failures_7d", label: "Fails 7d", align: "right" }, { key: "open_tickets", label: "Tickets", align: "right" }]} />
            <details><summary className="text-xs text-muted cursor-pointer">Rule JSON</summary><JsonView value={res.rules} /></details>
            <Field label="Segment name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <div className="flex gap-2"><Button onClick={() => onEditInBuilder(res.rules!)}>Edit in builder</Button><Button variant="primary" onClick={() => setConfirm(true)}>Save segment</Button></div>
          </div>
        )}
      </Card>
      <Confirm open={confirm} onClose={() => setConfirm(false)} onConfirm={save} title="Save AI-generated segment?" confirmLabel="Save segment" body={`Creates a dynamic ${purpose} segment with ${fmt.int(res?.count)} current members. Membership updates automatically; mandatory compliance exclusions apply at execution time.`} />
    </div>
  );
}

// ───────── events ─────────
export function EventsTab() {
  const { me, toast } = useGlobal();
  const [f, setF] = useState({ player_id: "", event_name: "", provider_id: "", platform: "", category: "" });
  const qs = useMemo(() => { const p = new URLSearchParams({ limit: "200" }); for (const [k, v] of Object.entries(f)) if (v) p.set(k, v); return p.toString(); }, [f]);
  const ev = useApi<{ rows: Row[]; rejections: Row[]; volume: Array<{ event_name: string; n: number }> }>(`events?${qs}`);
  const defs = useApi<Row[]>("event-definitions");
  const sample = () => JSON.stringify({ event_id: `evt_test_${Date.now()}`, event_name: "game_launch_failed", player_id: "P100005", game_id: "gm_003", provider_id: "prv_03", platform: "app", loading_duration: 18000, error_code: "PROVIDER_TIMEOUT" }, null, 2);
  const [body, setBody] = useState(sample); const [result, setResult] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const ingest = async () => { setBusy(true); try { setResult(await api("events", { body: JSON.parse(body) })); ev.refresh(); } catch (e) { toast({ kind: "error", title: "Ingest failed", body: (e as Error).message }); } setBusy(false); };
  return (
    <div className="space-y-3">
      <div className="grid lg:grid-cols-3 gap-3">
        <Card title="Event volume (24h)" className="lg:col-span-2">{ev.data ? <Chart height={240} option={bar(ev.data.volume.map((v) => v.event_name.replace("game_", "")), [{ name: "Events", data: ev.data.volume.map((v) => v.n) }])} /> : <Loading />}</Card>
        <Card title="Ingest test event" subtitle="Validation · dictionary check · dedup by event_id">
          {can(me, "events.ingest") ? <div className="space-y-2">
            <Textarea rows={8} className="w-full font-mono text-[11.5px]" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Event JSON" />
            <div className="flex gap-2"><Button variant="primary" onClick={ingest} loading={busy}>Send</Button><Button onClick={() => setBody(sample())}>New event id</Button></div>
            {result != null && <JsonView value={result} />}
            <div className="text-[11px] text-faint">Send the same body twice to see duplicate prevention.</div>
          </div> : <Notice>Requires events.ingest.</Notice>}
        </Card>
      </div>
      <Card title="Event Explorer">
        <div className="flex flex-wrap gap-2 mb-2">
          <Input placeholder="player_id" value={f.player_id} onChange={(e) => setF({ ...f, player_id: e.target.value })} className="w-32" aria-label="Player id" />
          <Select aria-label="Event" value={f.event_name} onChange={(e) => setF({ ...f, event_name: e.target.value })} options={[{ value: "", label: "Any event" }, ...(defs.data ?? []).map((d) => String(d.name))]} />
          <Input placeholder="provider_id" value={f.provider_id} onChange={(e) => setF({ ...f, provider_id: e.target.value })} className="w-28" aria-label="Provider" />
          <Select aria-label="Platform" value={f.platform} onChange={(e) => setF({ ...f, platform: e.target.value })} options={[{ value: "", label: "Any platform" }, "app", "h5", "pc"]} />
          <Select aria-label="Category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} options={[{ value: "", label: "Any category" }, "discovery", "experience", "behavior", "preference", "service", "kyc", "responsible_gaming", "account"]} />
        </div>
        {ev.data ? <DataTable dense rows={ev.data.rows} exportName="events" rowKey={(r) => String(r.seq)} cols={[
          { key: "event_time", label: "Time", render: (r) => fmt.date(r.event_time) }, { key: "event_name", label: "Event", render: (r) => <span className="font-mono text-[11.5px]">{String(r.event_name)}</span> },
          { key: "player_id", label: "Player", render: (r) => r.player_id ? <a className="text-accent font-mono" href={`/audience/${r.player_id}`}>{String(r.player_id)}</a> : "–" },
          { key: "game_id", label: "Game" }, { key: "provider_id", label: "Provider" }, { key: "platform", label: "Platform" },
          { key: "loading_duration", label: "Load", align: "right", render: (r) => (r.loading_duration ? fmt.ms(r.loading_duration) : "–") },
          { key: "error_code", label: "Error", render: (r) => (r.error_code ? <Badge tone="bad">{String(r.error_code)}</Badge> : "–") }, { key: "source", label: "Source" }, { key: "schema_version", label: "v" },
        ]} /> : <Loading rows={6} />}
        <div className="text-[11px] text-faint mt-1">Restricted gaming-transaction events are hidden unless your role holds gaming_transactions.read.</div>
      </Card>
      <div className="grid lg:grid-cols-2 gap-3">
        <Card title="Event dictionary" subtitle="Configurable, versioned definitions">
          {defs.data ? <DataTable dense rows={defs.data} rowKey={(r) => String(r.name)} search={(r) => String(r.name)} cols={[
            { key: "name", label: "Event", render: (r) => <span className="font-mono text-[11.5px]">{String(r.name)}</span> }, { key: "category", label: "Category" },
            { key: "required_attributes", label: "Required", render: (r) => (r.required_attributes as string[]).join(", ") }, { key: "version", label: "v", render: (r) => `v${r.version}` },
            { key: "restricted", label: "", render: (r) => (r.restricted ? <Badge tone="bad">restricted</Badge> : r.enabled ? null : <Badge>disabled</Badge>) },
          ]} /> : <Loading />}
        </Card>
        <Card title="Recent rejections">
          {ev.data ? <DataTable dense rows={ev.data.rejections} empty={<Empty title="No rejected events" />} cols={[{ key: "at", label: "At", render: (r) => fmt.date(r.at) }, { key: "event_id", label: "Event id", className: "font-mono text-[11px]" }, { key: "event_name", label: "Event" }, { key: "reason", label: "Reason", className: "max-w-64 truncate" }]} /> : <Loading />}
        </Card>
      </div>
    </div>
  );
}

// ───────── data management ─────────
export function DataTab() {
  const { me } = useGlobal();
  const s = useApi<{ data_sources: Row[]; field_mapping: Row[] }>(can(me, "settings.read") ? "settings" : null);
  if (!can(me, "settings.read")) return <Notice>Data source management requires the settings.read permission.</Notice>;
  return (
    <div className="space-y-3">
      <Notice>All data sources run through <b>mock adapters</b> until explicitly configured and authorized (see docs/INTEGRATIONS.md). CSV import is available as a mock adapter: files are validated against the event dictionary and field mapping before ingestion.</Notice>
      <Card title="Data sources">{s.data ? <DataTable dense rows={s.data.data_sources} cols={[
        { key: "name", label: "Source", render: (r) => <span className="font-medium">{String(r.name)}</span> }, { key: "kind", label: "Kind" }, { key: "source_type", label: "Transport" },
        { key: "mode", label: "Mode", render: (r) => <Badge tone="info">{String(r.mode)}</Badge> }, { key: "status", label: "Status", render: (r) => <Status value={String(r.status)} /> },
        { key: "records", label: "Records", align: "right", render: (r) => fmt.int(r.records) }, { key: "last_sync_at", label: "Last sync", render: (r) => fmt.ago(r.last_sync_at) },
        { key: "freshness_minutes", label: "SLA", render: (r) => `${r.freshness_minutes} min` },
      ]} /> : <Loading />}</Card>
      <Card title="Field mapping" subtitle="Profile fields usable in segmentation and their source system">{s.data ? <DataTable dense rows={s.data.field_mapping} rowKey={(r) => String(r.field)} search={(r) => String(r.field)} cols={[
        { key: "field", label: "Field", render: (r) => <span className="font-mono text-[11.5px]">{String(r.field)}</span> }, { key: "label", label: "Label" }, { key: "type", label: "Type" }, { key: "source", label: "Source" }, { key: "description", label: "Description", className: "max-w-80 truncate" },
      ]} /> : <Loading />}</Card>
    </div>
  );
}

