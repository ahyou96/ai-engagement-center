"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, Copy, KeyRound, RefreshCw } from "lucide-react";
import { api, can, fmt, useApi, useGlobal } from "@/components/hooks";
import { Badge, Button, Card, Confirm, DataTable, ErrorState, Field, Input, KV, Loading, Modal, Notice, PageHeader, Select, Status, Tabs, Toggle } from "@/components/ui";

type R = Record<string, unknown>;
type S = {
  organization: { name?: string; timezone?: string; currency?: string; data_retention_days?: number; audit_retention_days?: number };
  users: Array<{ id: string; email: string; name: string; role_id: string; status: string; created_at: string }>;
  roles: Array<{ id: string; name: string; description: string; permissions: string[] }>; permissions: string[];
  ai_providers: Array<{ id: string; name: string; provider_type: string; base_url: string | null; model: string | null; env_key: string | null; enabled: number; is_default: number; credential_configured: boolean }>;
  provider_status: Array<{ id: string; label: string; configured: boolean; model: string | null }>; active_provider: string;
  agents: Array<{ key: string; name: string; description: string; enabled: number; model: string; allowed_tools: string[] }>;
  data_sources: Array<{ id: string; name: string; source_type: string; kind: string; mode: string; status: string; last_sync_at: string; records: number; freshness_minutes: number }>;
  webhooks: Array<{ id: string; url: string; events: string[]; enabled: number; secret_ref: string; created_at: string }>;
  api_keys: Array<{ id: string; name: string; prefix: string; scopes: string; created_by: string; created_at: string; revoked_at: string | null }>;
  flags: Array<{ key: string; description: string; enabled: number; updated_at: string }>;
  scheduler: { discovery_scan_minutes?: number; journey_tick_seconds?: number }; scheduled_runs: Array<{ id: string; scenario: string; mode: string; simulation: boolean; due: string; by: string }>;
  policy: { max_auto_audience?: number };
  health: { db: string; audit_chain: { ok: boolean; checked: number }; events: { n: number; last: string }; runs_active: { n: number }; stream_backlog: { n: number }; node: string; uptime_s: number };
  field_mapping: Array<{ field: string; label: string; type: string; description: string; source: string; restricted?: string }>;
};
const TABS = [["organization", "Organization"], ["workspace", "Workspace & flags"], ["users", "Users"], ["roles", "Roles & permissions"], ["ai", "AI models & providers"], ["agents", "Agents"], ["data", "Data sources & BI"], ["api", "API & webhooks"], ["integrations", "Integrations"], ["mapping", "Field mapping"], ["scheduler", "Scheduler"], ["language", "Language"], ["health", "System health"], ["backup", "Backup & retention"]] as const;

function Inner() {
  const { t, me } = useGlobal(); const sp = useSearchParams(); const router = useRouter();
  const tab = sp.get("tab") ?? "organization";
  const s = useApi<S>("settings");
  return (
    <div className="space-y-4">
      <PageHeader title={t("settings")} subtitle="Configuration is server-side; credentials are read from environment variables and never sent to the browser" actions={<Button size="sm" variant="ghost" onClick={s.refresh} aria-label="Refresh"><RefreshCw size={13} /></Button>} />
      <Tabs tabs={TABS.map(([key, label]) => ({ key, label }))} value={tab} onChange={(k) => router.replace(`/settings?tab=${k}`)} />
      {!can(me, "settings.write") && <Notice tone="info">Read-only: your role does not include settings.write.</Notice>}
      <ErrorState error={s.error} onRetry={s.refresh} />
      {!s.data ? <Loading rows={6} /> : <Body tab={tab} s={s.data} refresh={s.refresh} />}
    </div>
  );
}

function Body({ tab, s, refresh }: { tab: string; s: S; refresh: () => void }) {
  const { me, toast, lang, setLang } = useGlobal(); const w = can(me, "settings.write");
  const call = async (path: string, body: unknown, method?: string, ok = "Saved") => { try { const r = await api<R>(path, { body, method }); toast({ kind: "success", title: ok }); refresh(); return r; } catch (e) { toast({ kind: "error", title: "Failed", body: (e as Error).message }); return null; } };
  switch (tab) {
    case "organization": return <OrgForm s={s} w={w} call={call} />;
    case "workspace": return <div className="space-y-3">
      <Card title="Feature flags">{s.flags.map((f) => <div key={f.key} className="flex items-center gap-3 py-2 border-b border-border last:border-0"><div className="flex-1"><div className="text-[13px] font-medium">{f.description}</div><code className="text-[11px] text-faint">{f.key}</code></div><Toggle checked={!!f.enabled} disabled={!w} label={f.description} onChange={(v) => call(`settings/flags/${f.key}`, { enabled: v }, undefined, "Flag updated")} /></div>)}</Card>
      <PolicyLimit s={s} w={w} call={call} />
    </div>;
    case "users": return <Users s={s} w={w} call={call} />;
    case "roles": return <Card title="Roles × permissions" subtitle="Field-level masking: PII requires pii.read; financial aggregates finance.read; risk risk.read; betting transactions gaming_transactions.read">
      <div className="overflow-auto scroll-thin max-h-[640px]"><table className="text-[11.5px]"><thead className="sticky top-0 bg-panel"><tr><th className="text-left px-2 py-1.5 sticky left-0 bg-panel">Permission</th>{s.roles.filter((r) => !r.id.startsWith("__")).map((r) => <th key={r.id} className="px-2 py-1.5 whitespace-nowrap" title={r.description}>{r.name}</th>)}</tr></thead>
        <tbody>{s.permissions.map((p) => <tr key={p} className="border-t border-border"><td className="px-2 py-1 font-mono sticky left-0 bg-panel">{p}</td>{s.roles.filter((r) => !r.id.startsWith("__")).map((r) => <td key={r.id} className="text-center">{r.permissions.includes(p) ? <Check size={12} className="inline text-ok" /> : <span className="text-faint">·</span>}</td>)}</tr>)}</tbody></table></div>
    </Card>;
    case "ai": return <div className="space-y-3">
      <Notice tone="info">Active provider: <b>{s.active_provider}</b>. API keys are configured only as server environment variables (e.g. <code>ANTHROPIC_API_KEY</code>, <code>OPENAI_API_KEY</code>, <code>OPENAI_COMPATIBLE_BASE_URL/API_KEY/MODEL</code>) in <code>.env.local</code>; set <code>AEC_AI_PROVIDER</code> to <code>anthropic</code> | <code>openai</code> | <code>openai_compatible</code> and restart. Keys are never displayed or accepted in the browser. Without a configured key the platform falls back to the deterministic mock provider.</Notice>
      <Card title="Provider status"><DataTable rows={s.provider_status as unknown as R[]} cols={[{ key: "label", label: "Provider" }, { key: "model", label: "Model", render: (r) => String(r.model ?? "–") }, { key: "configured", label: "Configured", render: (r) => <Badge tone={r.configured ? "ok" : "neutral"}>{r.configured ? "yes" : "no"}</Badge> }, { key: "active", label: "Active", render: (r) => (r.id === s.active_provider ? <Badge tone="accent">active</Badge> : "") }]} /></Card>
      <Card title="Provider catalog (unified interface)"><DataTable rows={s.ai_providers as unknown as R[]} cols={[{ key: "name", label: "Name" }, { key: "provider_type", label: "Type", render: (r) => <code className="text-[11px]">{String(r.provider_type)}</code> }, { key: "base_url", label: "Endpoint", render: (r) => <span className="text-xs text-muted">{String(r.base_url ?? "–")}</span> }, { key: "model", label: "Model" }, { key: "cred", label: "Credential", render: (r) => r.env_key ? <span className="text-xs"><Badge tone={r.credential_configured ? "ok" : "neutral"}>{r.credential_configured ? "configured" : "not configured"}</Badge> <code className="text-[10.5px] text-faint">{String(r.env_key)}</code></span> : <span className="text-xs text-muted">none required</span> }]} /></Card>
    </div>;
    case "agents": return <Card title="AI agents" subtitle="Agents only reach platform actions through policy-enforced tools; outputs are untrusted proposals until validated">
      <DataTable rows={s.agents as unknown as R[]} rowKey={(r) => String(r.key)} cols={[{ key: "name", label: "Agent", render: (r) => <div><div className="font-medium">{String(r.name)}</div><div className="text-[11px] text-muted">{String(r.description)}</div></div> }, { key: "allowed_tools", label: "Allowed tools", render: (r) => <div className="flex flex-wrap gap-1">{(r.allowed_tools as string[]).map((tl) => <Badge key={tl}>{tl}</Badge>)}{!(r.allowed_tools as string[]).length && <span className="text-faint text-xs">none</span>}</div> }, { key: "model", label: "Model" }, { key: "enabled", label: "Enabled", render: (r) => <Toggle checked={!!r.enabled} disabled={!w} label={String(r.name)} onChange={(v) => call(`settings/agents/${r.key}`, { enabled: v }, undefined, "Agent updated")} /> }]} />
    </Card>;
    case "data": return <div className="space-y-3">
      <Notice tone="warn">All data sources run through mock adapters. Production integrations (BI warehouse, CRM, KYC, payment, gaming, customer service, offers) stay disabled until explicitly configured and authorized — see docs/INTEGRATIONS.md.</Notice>
      <Card title="Data sources"><DataTable rows={s.data_sources as unknown as R[]} cols={[{ key: "name", label: "Source" }, { key: "kind", label: "Kind" }, { key: "source_type", label: "Type" }, { key: "status", label: "Status", render: (r) => <Status value={String(r.status)} /> }, { key: "mode", label: "Mode", render: (r) => <Badge tone="info">{String(r.mode)}</Badge> }, { key: "records", label: "Records", align: "right", render: (r) => fmt.int(r.records) }, { key: "last_sync_at", label: "Last sync", render: (r) => fmt.ago(r.last_sync_at) }, { key: "f", label: "Expected freshness", render: (r) => `${r.freshness_minutes} min` }, { key: "a", label: "", render: (r) => w ? <Button size="sm" onClick={(e) => { e.stopPropagation(); call(`settings/data-sources/${r.id}/sync`, {}, undefined, "Sync triggered (mock)"); }}>Sync now (mock)</Button> : null }]} /></Card>
      <Card title="BI connections">
        <div className="text-[12.5px] text-muted space-y-1"><p>The BI warehouse adapter (<code>ds_bi</code>) is a read-only interface for enterprise BI. Supported integration styles: database (read replica / warehouse views), REST API, CSV import, and webhooks for event push.</p><p>Event ingestion endpoint: <code>POST /api/events</code> with header <code>x-api-key</code> (scope <code>events.ingest</code>). See the API tab.</p></div>
      </Card>
    </div>;
    case "api": return <ApiKeys s={s} w={w} call={call} />;
    case "integrations": return <div className="grid md:grid-cols-2 gap-3">
      <Card title="Channel integrations"><p className="text-[12.5px] text-muted">Messaging providers (SMS, Email, Push, WhatsApp, Viber, Messenger, Telegram, In-App) are configured in Omni Channel. All run in mock mode; a channel is never shown as connected unless verified.</p><Link href="/channels" className="text-accent text-[13px] mt-2 inline-block">Open Omni Channel →</Link></Card>
      <Card title="Event dictionary"><p className="text-[12.5px] text-muted">Configurable gaming & customer event definitions with required attributes and versions.</p><Link href="/audience?tab=events" className="text-accent text-[13px] mt-2 inline-block">Open Event Explorer →</Link></Card>
    </div>;
    case "mapping": return <Card title="Data field mapping" subtitle="Whitelisted CDP fields usable in segments, journeys and the AI segment builder"><DataTable search={(r) => `${r.field} ${r.label}`} exportName="field-mapping" rows={s.field_mapping as unknown as R[]} rowKey={(r) => String(r.field)} cols={[{ key: "field", label: "Field", render: (r) => <code className="text-[11.5px]">{String(r.field)}</code> }, { key: "label", label: "Label" }, { key: "type", label: "Type", render: (r) => <Badge>{String(r.type)}</Badge> }, { key: "source", label: "Source system", render: (r) => <code className="text-[11px]">{String(r.source)}</code> }, { key: "description", label: "Description" }]} /></Card>;
    case "scheduler": return <Scheduler s={s} w={w} call={call} />;
    case "language": return <Card title="Language"><div className="flex items-center gap-3"><Select value={lang} onChange={(e) => setLang(e.target.value as "en" | "zh")} options={[{ value: "en", label: "English" }, { value: "zh", label: "简体中文" }]} aria-label="Language" /><span className="text-xs text-muted">Navigation, shell and common actions are translated; stored per browser.</span></div></Card>;
    case "health": {
      const h = s.health;
      return <Card title="System health"><KV items={[["Database", <Badge key="d" tone="ok">{h.db}</Badge>], ["Audit chain", <Badge key="a" tone={h.audit_chain.ok ? "ok" : "bad"}>{h.audit_chain.ok ? "intact" : "BROKEN"} · {h.audit_chain.checked} records</Badge>], ["Events", `${fmt.int(h.events.n)} · last ingested ${fmt.ago(h.events.last)}`], ["Active workflow runs", fmt.int(h.runs_active.n)], ["Stream backlog (persisted events)", fmt.int(h.stream_backlog.n)], ["Node.js", h.node], ["Uptime", `${Math.floor(h.uptime_s / 3600)}h ${Math.floor((h.uptime_s % 3600) / 60)}m`], ["Health endpoint", <code key="hc">GET /api/health</code>]]} /></Card>;
    }
    case "backup": return <Card title="Backup & retention">
      <KV items={[["Data retention", `${s.organization.data_retention_days ?? "–"} days`], ["Audit retention", `${s.organization.audit_retention_days ?? "–"} days (append-only)`]]} />
      <div className="text-[12.5px] text-muted mt-3 space-y-1.5">
        <p>First release stores data in SQLite (WAL mode) at <code>AEC_DB_PATH</code>. Back up with <code>sqlite3 data/aec.db &quot;.backup data/backup-$(date +%F).db&quot;</code> (online-safe) or snapshot the Docker volume.</p>
        <p>Restore by stopping the app and replacing the database file. Workflow runs left in progress resume automatically on restart.</p>
        <p>Production: migrate to PostgreSQL with point-in-time recovery, and ship audit logs to WORM storage. Retention periods above are configuration only — enforce them with scheduled purge jobs after legal review.</p>
      </div>
    </Card>;
  }
  return null;
}

type Call = (path: string, body: unknown, method?: string, ok?: string) => Promise<R | null>;
function OrgForm({ s, w, call }: { s: S; w: boolean; call: Call }) {
  const [o, setO] = useState(s.organization);
  return <Card title="Organization" actions={<Button size="sm" variant="primary" disabled={!w} onClick={() => call("settings/organization", o, "PUT", "Organization saved")}>Save</Button>}>
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
      <Field label="Name"><Input value={o.name ?? ""} disabled={!w} onChange={(e) => setO({ ...o, name: e.target.value })} /></Field>
      <Field label="Timezone"><Input value={o.timezone ?? ""} disabled={!w} onChange={(e) => setO({ ...o, timezone: e.target.value })} /></Field>
      <Field label="Currency"><Input value={o.currency ?? ""} disabled={!w} onChange={(e) => setO({ ...o, currency: e.target.value })} /></Field>
      <Field label="Data retention (days)"><Input type="number" value={o.data_retention_days ?? 0} disabled={!w} onChange={(e) => setO({ ...o, data_retention_days: Number(e.target.value) })} /></Field>
      <Field label="Audit retention (days)"><Input type="number" value={o.audit_retention_days ?? 0} disabled={!w} onChange={(e) => setO({ ...o, audit_retention_days: Number(e.target.value) })} /></Field>
    </div>
    <div className="text-[11px] text-faint mt-3">Tenant: org_demo (single-tenant demo; all tables carry org_id for tenant isolation).</div>
  </Card>;
}

function PolicyLimit({ s, w, call }: { s: S; w: boolean; call: Call }) {
  const [v, setV] = useState(s.policy.max_auto_audience ?? 2000);
  return <Card title="Automatic decision policy" actions={<Button size="sm" variant="primary" disabled={!w} onClick={() => call("settings/policy", { max_auto_audience: v }, "PUT", "Policy saved")}>Save</Button>}>
    <Field label="Maximum audience for automatic (no-approval) actions" hint="Larger audiences always escalate to human approval"><Input type="number" value={v} disabled={!w} onChange={(e) => setV(Number(e.target.value))} className="w-40" /></Field>
  </Card>;
}

function Users({ s, w, call }: { s: S; w: boolean; call: Call }) {
  const [open, setOpen] = useState(false); const [f, setF] = useState({ email: "", name: "", role_id: "analyst", password: "" });
  const roles = s.roles.filter((r) => !r.id.startsWith("__")).map((r) => ({ value: r.id, label: r.name }));
  return <Card title="Users" actions={w && <Button size="sm" variant="primary" onClick={() => setOpen(true)}>Add user</Button>}>
    <DataTable rows={s.users as unknown as R[]} cols={[{ key: "name", label: "Name" }, { key: "email", label: "Email" },
      { key: "role_id", label: "Role", render: (r) => w ? <Select value={String(r.role_id)} options={roles} onChange={(e) => call(`settings/users/${r.id}`, { role_id: e.target.value }, "PUT", "Role updated")} aria-label="Role" /> : String(r.role_id) },
      { key: "status", label: "Status", render: (r) => <Status value={String(r.status)} /> }, { key: "created_at", label: "Created", render: (r) => fmt.day(r.created_at) },
      { key: "a", label: "", render: (r) => w ? <Button size="sm" variant="ghost" onClick={() => call(`settings/users/${r.id}`, { status: r.status === "active" ? "disabled" : "active" }, "PUT", "User updated")}>{r.status === "active" ? "Disable" : "Enable"}</Button> : null }]} />
    <Modal open={open} onClose={() => setOpen(false)} title="Add user" footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={async () => { if (await call("settings/users", f, undefined, "User created")) setOpen(false); }}>Create</Button></>}>
      <div className="space-y-3"><Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><Field label="Email"><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Role"><Select value={f.role_id} options={roles} onChange={(e) => setF({ ...f, role_id: e.target.value })} /></Field><Field label="Initial password" hint="Min 8 characters; stored as scrypt hash"><Input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field></div>
    </Modal>
  </Card>;
}

function ApiKeys({ s, w, call }: { s: S; w: boolean; call: Call }) {
  const [name, setName] = useState(""); const [key, setKey] = useState<string | null>(null); const [copied, setCopied] = useState(false); const [revoke, setRevoke] = useState<string | null>(null);
  useEffect(() => { if (!key) setCopied(false); }, [key]);
  return <div className="space-y-3">
    <Card title="API keys" subtitle="Used for server-to-server event ingestion (POST /api/events with x-api-key header)">
      {w && <div className="flex gap-2 mb-3"><Input placeholder="Key name (e.g. Gaming event pipeline)" value={name} onChange={(e) => setName(e.target.value)} className="w-72" /><Button variant="primary" disabled={name.length < 3} onClick={async () => { const r = await call("settings/api-keys", { name, scopes: ["events.ingest"] }, undefined, "API key created"); if (r?.key) { setKey(String(r.key)); setName(""); } }}><KeyRound size={13} />Create key</Button></div>}
      <DataTable rows={s.api_keys as unknown as R[]} cols={[{ key: "name", label: "Name" }, { key: "prefix", label: "Prefix", render: (r) => <code className="text-[11px]">{String(r.prefix)}…</code> }, { key: "scopes", label: "Scopes", render: (r) => <code className="text-[11px]">{String(r.scopes)}</code> }, { key: "created_by", label: "Created by" }, { key: "created_at", label: "Created", render: (r) => fmt.day(r.created_at) }, { key: "revoked_at", label: "Status", render: (r) => <Status value={r.revoked_at ? "rejected" : "active"} /> }, { key: "a", label: "", render: (r) => w && !r.revoked_at ? <Button size="sm" variant="ghost" onClick={() => setRevoke(String(r.id))}>Revoke</Button> : null }]} />
    </Card>
    <Card title="Webhooks">
      <Notice tone="info" className="mb-3">Inbound delivery receipts: <code>POST /api/webhooks/delivery</code> signed with header <code>x-aec-signature</code> = hex HMAC-SHA256 of the raw body using <code>AEC_WEBHOOK_SECRET</code>. Outbound webhooks are disabled until an integration is enabled.</Notice>
      <DataTable rows={s.webhooks as unknown as R[]} cols={[{ key: "url", label: "URL", render: (r) => <code className="text-[11px]">{String(r.url)}</code> }, { key: "events", label: "Events", render: (r) => <div className="flex flex-wrap gap-1">{(r.events as string[]).map((e) => <Badge key={e}>{e}</Badge>)}</div> }, { key: "enabled", label: "Enabled", render: (r) => <Badge tone={r.enabled ? "ok" : "neutral"}>{r.enabled ? "on" : "off"}</Badge> }, { key: "secret_ref", label: "Secret", render: (r) => <code className="text-[11px] text-faint">{String(r.secret_ref)}</code> }]} />
    </Card>
    <Modal open={!!key} onClose={() => setKey(null)} title="New API key" footer={<Button variant="primary" onClick={() => setKey(null)}>Done</Button>}>
      <Notice tone="warn" className="mb-3">This key is shown once. Store it in your secret manager — it cannot be retrieved again.</Notice>
      <div className="flex gap-2"><code className="flex-1 break-all text-[12px] bg-panel-2 border border-border rounded px-2 py-1.5">{key}</code><Button onClick={async () => { try { await navigator.clipboard.writeText(key ?? ""); setCopied(true); } catch { /* clipboard unavailable */ } }}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "Copied" : "Copy"}</Button></div>
    </Modal>
    <Confirm open={!!revoke} onClose={() => setRevoke(null)} danger title="Revoke API key?" confirmLabel="Revoke" body="Requests using this key will be rejected immediately. This cannot be undone." onConfirm={async () => { await call(`settings/api-keys/${revoke}/revoke`, {}, undefined, "API key revoked"); setRevoke(null); }} />
  </div>;
}

function Scheduler({ s, w, call }: { s: S; w: boolean; call: Call }) {
  const [v, setV] = useState({ discovery_scan_minutes: s.scheduler.discovery_scan_minutes ?? 0, journey_tick_seconds: s.scheduler.journey_tick_seconds ?? 30 });
  return <div className="space-y-3">
    <Card title="Scheduler" actions={<Button size="sm" variant="primary" disabled={!w} onClick={() => call("settings/scheduler", v, "PUT", "Scheduler saved")}>Save</Button>}>
      <div className="grid sm:grid-cols-2 gap-4"><Field label="Discovery scan interval (minutes, 0 = off)"><Input type="number" value={v.discovery_scan_minutes} disabled={!w} onChange={(e) => setV({ ...v, discovery_scan_minutes: Number(e.target.value) })} /></Field>
        <Field label="Journey tick (seconds)" hint="Background job processes due journey waits"><Input type="number" value={v.journey_tick_seconds} disabled={!w} onChange={(e) => setV({ ...v, journey_tick_seconds: Number(e.target.value) })} /></Field></div>
      <div className="text-[11px] text-faint mt-2">First release runs an in-process scheduler (30s tick: journey waits, approval expiry, scheduled runs, segment refresh). Production plan: dedicated worker with a durable queue.</div>
    </Card>
    <Card title="Scheduled workflow runs" subtitle="Created from Opportunity Finder → Scheduled run"><DataTable rows={s.scheduled_runs as unknown as R[]} empty={<div className="p-4 text-xs text-muted">No scheduled runs.</div>} cols={[{ key: "scenario", label: "Scenario" }, { key: "mode", label: "Mode" }, { key: "simulation", label: "Simulation", render: (r) => (r.simulation ? "yes" : "no") }, { key: "due", label: "Due", render: (r) => fmt.date(r.due) }, { key: "by", label: "Scheduled by" }]} /></Card>
  </div>;
}

export default function Page() { return <Suspense><Inner /></Suspense>; }
