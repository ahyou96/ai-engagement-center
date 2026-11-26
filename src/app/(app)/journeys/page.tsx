"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { api, useApi, useGlobal, fmt, can } from "@/components/hooks";
import { Badge, Button, Card, DataTable, ErrorState, Field, Input, Loading, Modal, PageHeader, Select, Status } from "@/components/ui";

type J = { id: string; name: string; purpose: string; status: string; published_version: number | null; strategy_category: string | null; active_execs: number; total_execs: number; updated_at: string; description: string | null };

export default function JourneysPage() {
  const { t, toast, me } = useGlobal(); const router = useRouter();
  const list = useApi<J[]>("journeys");
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", purpose: "service", description: "", strategy_category: "" });
  const create = async () => {
    setBusy(true);
    try { const r = await api<{ id: string }>("journeys", { body: { ...form, strategy_category: form.strategy_category || null } }); toast({ kind: "success", title: "Journey created" }); router.push(`/journeys/${r.id}`); }
    catch (e) { toast({ kind: "error", title: "Create failed", body: (e as Error).message }); }
    setBusy(false);
  };
  return (
    <div className="space-y-4">
      <PageHeader title={t("journeys")} subtitle="Visual automation workflows — triggers, conditions, actions and exit rules. Service journeys publish directly; promotional and entitlement journeys require approval."
        actions={can(me, "journeys.write") && <Button variant="primary" onClick={() => setOpen(true)}><Plus size={14} />{t("create")}</Button>} />
      <ErrorState error={list.error} onRetry={list.refresh} />
      <Card pad={false}><div className="p-3">
        {list.loading && !list.data ? <Loading /> : <DataTable rows={(list.data ?? []) as unknown as Record<string, unknown>[]} exportName="journeys" search={(r) => `${r.name} ${r.purpose} ${r.status}`} onRow={(r) => router.push(`/journeys/${r.id}`)} cols={[
          { key: "name", label: "Journey", render: (r) => <div><div className="font-medium">{String(r.name)}</div><div className="text-xs text-muted truncate max-w-[340px]">{String(r.description ?? "")}</div></div> },
          { key: "purpose", label: "Purpose", render: (r) => <Badge tone={["marketing", "membership"].includes(String(r.purpose)) ? "warn" : "info"}>{String(r.purpose)}</Badge> },
          { key: "status", label: "Status", render: (r) => <Status value={String(r.status)} /> },
          { key: "published_version", label: "Published", render: (r) => (r.published_version ? `v${r.published_version}` : "–") },
          { key: "strategy_category", label: "Strategy", render: (r) => (r.strategy_category ? <code className="text-xs font-mono">{String(r.strategy_category)}</code> : "–") },
          { key: "active_execs", label: "Active", align: "right", render: (r) => fmt.int(r.active_execs) },
          { key: "total_execs", label: "Total executions", align: "right", render: (r) => fmt.int(r.total_execs) },
          { key: "updated_at", label: "Updated", render: (r) => fmt.ago(r.updated_at) },
        ]} />}
      </div></Card>
      <Modal open={open} onClose={() => setOpen(false)} title="New journey" footer={<><Button onClick={() => setOpen(false)}>{t("cancel")}</Button><Button variant="primary" loading={busy} disabled={form.name.length < 3} onClick={create}>{t("create")}</Button></>}>
        <div className="space-y-3">
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Purpose" hint="Purpose determines consent and compliance rules applied at execution time."><Select value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} options={["service", "operational", "protective", "membership", "marketing"]} /></Field>
          <Field label="Description"><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <Field label="Strategy category (optional)" hint="Wait nodes can read parameters from the active approved strategy version."><Select value={form.strategy_category} onChange={(e) => setForm({ ...form, strategy_category: e.target.value })} options={[{ value: "", label: "None" }, "kyc_assistance", "provider_monitoring", "membership_entitlements", "channel_routing", "rg_protection"]} /></Field>
        </div>
      </Modal>
    </div>
  );
}
