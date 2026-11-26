"use client";
import { Suspense, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Bot } from "lucide-react";
import { api, useGlobal } from "@/components/hooks";
import { Button, PageHeader, Tabs, Notice } from "@/components/ui";
import { SegmentBuilder, emptyRule, Rule } from "./builder";
import { OverviewTab, ExplorerTab, GamingTab, IdentityTab, TagsTab, SegmentsTab, AiTab, EventsTab, DataTab } from "./panels";

const TABS = [
  { key: "overview", label: "Audience Overview" }, { key: "explorer", label: "User Explorer" }, { key: "gaming", label: "Gaming Intelligence" },
  { key: "identity", label: "Identity Resolution" }, { key: "tags", label: "Tags" }, { key: "segments", label: "Segments" },
  { key: "builder", label: "Segment Builder" }, { key: "ai", label: "AI Segment Builder" }, { key: "events", label: "Event Explorer" }, { key: "data", label: "Data Management" },
];

function AudienceInner() {
  const sp = useSearchParams(); const router = useRouter(); const path = usePathname();
  const { t, openCopilot, toast } = useGlobal();
  const tab = sp.get("tab") ?? "overview";
  const go = (params: Record<string, string | null>) => {
    const p = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(params)) { if (v == null) p.delete(k); else p.set(k, v); }
    router.replace(`${path}?${p.toString()}`, { scroll: false });
  };
  const [rules, setRules] = useState<Rule>(emptyRule());
  const [editing, setEditing] = useState<string | null>(null);
  const initialFilters = Object.fromEntries(["q", "lifecycle_stage", "kyc_status", "vip_tier", "primary_platform", "os", "segment"].filter((k) => sp.get(k)).map((k) => [k, sp.get(k)!]));
  const toBuilder = (r: Rule, segId?: string) => { setRules(r); setEditing(segId ?? null); go({ tab: "builder", id: null }); };

  return (
    <div>
      <PageHeader title={t("audience")} subtitle="Gaming CDP · Customer 360° · identity resolution · tags · dynamic segmentation"
        actions={<Button size="sm" variant="subtle" onClick={() => openCopilot("Find users who experienced game loading failures in the last seven days and have unresolved customer service tickets.")}><Bot size={13} />Build segment with Copilot</Button>} />
      <Tabs tabs={TABS} value={tab} onChange={(k) => go({ tab: k, id: null })} className="mb-4" />
      {tab === "overview" && <OverviewTab />}
      {tab === "explorer" && <ExplorerTab key={JSON.stringify(initialFilters)} initial={initialFilters} />}
      {tab === "gaming" && <GamingTab />}
      {tab === "identity" && <IdentityTab />}
      {tab === "tags" && <TagsTab />}
      {tab === "segments" && <SegmentsTab openId={sp.get("id")} onOpen={(id) => go({ id })} onEditInBuilder={(r, id) => toBuilder(r, id)} />}
      {tab === "builder" && <div className="space-y-3">
        {editing && <Notice>Editing rules of segment <code className="font-mono">{editing}</code>. <button className="underline ml-1" onClick={async () => { try { await api(`segments/${editing}`, { method: "PUT", body: { rules } }); toast({ kind: "success", title: "Rules updated", body: "New segment version created and re-evaluated" }); go({ tab: "segments", id: editing }); setEditing(null); } catch (e) { toast({ kind: "error", title: (e as Error).message }); } }}>Save as new version of this segment</button> or save below as a new segment.</Notice>}
        <SegmentBuilder rules={rules} setRules={setRules} onSaved={(id) => go({ tab: "segments", id })} />
      </div>}
      {tab === "ai" && <AiTab onEditInBuilder={(r) => toBuilder(r)} onSaved={(id) => go({ tab: "segments", id })} />}
      {tab === "events" && <EventsTab />}
      {tab === "data" && <DataTab />}
    </div>
  );
}

export default function AudiencePage() { return <Suspense><AudienceInner /></Suspense>; }
