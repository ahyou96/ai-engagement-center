"use client";
import { useEffect, useState } from "react";
import { Plus, Trash2, FolderPlus } from "lucide-react";
import { api, useApi, useGlobal, fmt } from "@/components/hooks";
import { Badge, Button, Card, Field, Input, Notice, Select, Toggle, cx } from "@/components/ui";

export type Rule =
  | { type: "group"; op: "and" | "or"; negate?: boolean; children: Rule[] }
  | { type: "attr"; field: string; op: string; value?: unknown }
  | { type: "event"; event: string; op: "gte" | "lte" | "eq"; count: number; within_days: number; provider_id?: string }
  | { type: "tag"; tag: string; has: boolean }
  | { type: "segment"; segment_id: string; in: boolean }
  | { type: "attr_change"; field: string; to: string; within_days: number };

type FieldDef = { label: string; type: "string" | "number" | "date" | "bool" | "enum"; options?: string[]; description: string };
export type Meta = { fields: Record<string, FieldDef>; events: Array<{ name: string }>; tags: Array<{ key: string; name: string }>; segments: Array<{ id: string; name: string }> };

const OPS: Record<FieldDef["type"], string[]> = {
  string: ["eq", "neq", "contains", "in", "not_in", "is_null", "not_null"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "is_null", "not_null"],
  date: ["within_last_days", "older_than_days", "is_null", "not_null"],
  bool: ["eq"],
  enum: ["eq", "neq", "in", "not_in"],
};
const OP_LABEL: Record<string, string> = { eq: "=", neq: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤", in: "in", not_in: "not in", contains: "contains", is_null: "is empty", not_null: "is set", within_last_days: "within last N days", older_than_days: "older than N days" };

export const emptyRule = (): Rule => ({ type: "group", op: "and", children: [] });

function newCond(kind: string, meta: Meta): Rule {
  switch (kind) {
    case "event": return { type: "event", event: meta.events[0]?.name ?? "game_launch_failed", op: "gte", count: 1, within_days: 7 };
    case "tag": return { type: "tag", tag: meta.tags[0]?.key ?? "", has: true };
    case "segment": return { type: "segment", segment_id: meta.segments[0]?.id ?? "", in: true };
    case "attr_change": return { type: "attr_change", field: "kyc_status", to: "verified", within_days: 7 };
    default: return { type: "attr", field: "kyc_status", op: "eq", value: "verified" };
  }
}

function Cond({ r, meta, onChange, onRemove }: { r: Rule; meta: Meta; onChange: (r: Rule) => void; onRemove: () => void }) {
  const fieldOpts = Object.entries(meta.fields).map(([k, v]) => ({ value: k, label: v.label }));
  let body: React.ReactNode = null;
  if (r.type === "attr") {
    const f = meta.fields[r.field] ?? { type: "string" as const, label: r.field, description: "" };
    const ops = OPS[f.type];
    const multi = r.op === "in" || r.op === "not_in";
    const noVal = r.op === "is_null" || r.op === "not_null";
    let valInput: React.ReactNode = null;
    if (!noVal) {
      if (f.type === "bool") valInput = <Select aria-label="Value" value={String(r.value ?? true)} onChange={(e) => onChange({ ...r, value: e.target.value === "true" })} options={["true", "false"]} />;
      else if (f.type === "enum" && !multi) valInput = <Select aria-label="Value" value={String(r.value ?? "")} onChange={(e) => onChange({ ...r, value: e.target.value })} options={f.options ?? []} />;
      else if (f.type === "enum" && multi) {
        const cur = Array.isArray(r.value) ? (r.value as string[]) : [];
        valInput = <div className="flex flex-wrap gap-1">{(f.options ?? []).map((o) => <button key={o} type="button" onClick={() => onChange({ ...r, value: cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o] })} className={cx("text-[11.5px] rounded border px-1.5 py-0.5", cur.includes(o) ? "border-accent bg-accent-soft text-accent" : "border-border text-muted")}>{o}</button>)}</div>;
      } else if (multi) valInput = <Input aria-label="Values (comma separated)" placeholder="a, b, c" value={Array.isArray(r.value) ? (r.value as string[]).join(", ") : ""} onChange={(e) => onChange({ ...r, value: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />;
      else valInput = <Input aria-label="Value" className="w-32" type={f.type === "number" || f.type === "date" ? "number" : "text"} value={String(r.value ?? "")} onChange={(e) => onChange({ ...r, value: f.type === "number" || f.type === "date" ? Number(e.target.value) : e.target.value })} />;
    }
    body = <>
      <Select aria-label="Field" value={r.field} onChange={(e) => { const nf = meta.fields[e.target.value]; const op = OPS[nf.type][0]; onChange({ type: "attr", field: e.target.value, op, value: nf.type === "enum" ? nf.options?.[0] : nf.type === "bool" ? true : nf.type === "date" ? 7 : nf.type === "number" ? 0 : "" }); }} options={fieldOpts} className="max-w-52" />
      <Select aria-label="Operator" value={r.op} onChange={(e) => onChange({ ...r, op: e.target.value, value: (e.target.value === "in" || e.target.value === "not_in") ? [] : f.type === "enum" ? f.options?.[0] : r.value })} options={ops.map((o) => ({ value: o, label: OP_LABEL[o] }))} />
      {valInput}
    </>;
  } else if (r.type === "event") {
    body = <>
      <Select aria-label="Event" value={r.event} onChange={(e) => onChange({ ...r, event: e.target.value })} options={meta.events.map((e) => e.name)} className="max-w-52" />
      <Select aria-label="Comparison" value={r.op} onChange={(e) => onChange({ ...r, op: e.target.value as "gte" })} options={[{ value: "gte", label: "≥" }, { value: "lte", label: "≤" }, { value: "eq", label: "=" }]} />
      <Input aria-label="Count" type="number" min={0} className="w-16" value={r.count} onChange={(e) => onChange({ ...r, count: Number(e.target.value) })} />
      <span className="text-xs text-muted">times in last</span>
      <Input aria-label="Days" type="number" min={1} className="w-16" value={r.within_days} onChange={(e) => onChange({ ...r, within_days: Number(e.target.value) || 1 })} />
      <span className="text-xs text-muted">days, provider</span>
      <Input aria-label="Provider id (optional)" placeholder="any" className="w-24" value={r.provider_id ?? ""} onChange={(e) => onChange({ ...r, provider_id: e.target.value || undefined })} />
    </>;
  } else if (r.type === "tag") {
    body = <>
      <Select aria-label="Has tag" value={r.has ? "has" : "lacks"} onChange={(e) => onChange({ ...r, has: e.target.value === "has" })} options={[{ value: "has", label: "has tag" }, { value: "lacks", label: "lacks tag" }]} />
      <Select aria-label="Tag" value={r.tag} onChange={(e) => onChange({ ...r, tag: e.target.value })} options={meta.tags.map((t) => ({ value: t.key, label: t.name }))} className="max-w-56" />
    </>;
  } else if (r.type === "segment") {
    body = <>
      <Select aria-label="In segment" value={r.in ? "in" : "not"} onChange={(e) => onChange({ ...r, in: e.target.value === "in" })} options={[{ value: "in", label: "in segment" }, { value: "not", label: "not in segment" }]} />
      <Select aria-label="Segment" value={r.segment_id} onChange={(e) => onChange({ ...r, segment_id: e.target.value })} options={meta.segments.map((s) => ({ value: s.id, label: s.name }))} className="max-w-64" />
    </>;
  } else if (r.type === "attr_change") {
    body = <>
      <Select aria-label="Field" value={r.field} onChange={(e) => onChange({ ...r, field: e.target.value })} options={fieldOpts} className="max-w-52" />
      <span className="text-xs text-muted">changed to</span>
      <Input aria-label="New value" className="w-28" value={r.to} onChange={(e) => onChange({ ...r, to: e.target.value })} />
      <span className="text-xs text-muted">in last</span>
      <Input aria-label="Days" type="number" min={1} className="w-16" value={r.within_days} onChange={(e) => onChange({ ...r, within_days: Number(e.target.value) || 1 })} />
      <span className="text-xs text-muted">days</span>
    </>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-panel px-2 py-1.5">
      <Badge tone="neutral">{r.type === "attr_change" ? "history" : r.type}</Badge>{body}
      <button type="button" aria-label="Remove condition" onClick={onRemove} className="ml-auto p-1 text-faint hover:text-bad"><Trash2 size={13} /></button>
    </div>
  );
}

export function GroupEditor({ g, meta, onChange, onRemove, depth = 0 }: { g: Extract<Rule, { type: "group" }>; meta: Meta; onChange: (r: Rule) => void; onRemove?: () => void; depth?: number }) {
  const [kind, setKind] = useState("attr");
  const set = (i: number, r: Rule) => onChange({ ...g, children: g.children.map((c, j) => (j === i ? r : c)) });
  const del = (i: number) => onChange({ ...g, children: g.children.filter((_, j) => j !== i) });
  return (
    <div className={cx("rounded-lg border p-2.5 space-y-2", depth % 2 ? "bg-panel-2 border-border" : "bg-panel border-border-strong")}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-border overflow-hidden" role="group" aria-label="Combine with">
          {(["and", "or"] as const).map((o) => <button key={o} type="button" onClick={() => onChange({ ...g, op: o })} className={cx("px-2 h-7 text-xs font-semibold uppercase", g.op === o ? "bg-accent text-accent-fg" : "text-muted")}>{o}</button>)}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted"><Toggle label="Negate group" checked={!!g.negate} onChange={(v) => onChange({ ...g, negate: v })} />NOT (exclude)</label>
        <div className="flex-1" />
        <Select aria-label="Condition type" value={kind} onChange={(e) => setKind(e.target.value)} options={[{ value: "attr", label: "Attribute" }, { value: "event", label: "Event count" }, { value: "tag", label: "Tag" }, { value: "segment", label: "Segment (set ops)" }, { value: "attr_change", label: "Attribute change" }]} />
        <Button size="sm" type="button" onClick={() => onChange({ ...g, children: [...g.children, newCond(kind, meta)] })}><Plus size={12} />Condition</Button>
        {depth < 4 && <Button size="sm" type="button" variant="ghost" onClick={() => onChange({ ...g, children: [...g.children, { type: "group", op: g.op === "and" ? "or" : "and", children: [] }] })}><FolderPlus size={12} />Group</Button>}
        {onRemove && <button type="button" aria-label="Remove group" onClick={onRemove} className="p-1 text-faint hover:text-bad"><Trash2 size={13} /></button>}
      </div>
      {!g.children.length && <div className="text-xs text-faint px-1">Empty group — matches everyone. Add conditions.</div>}
      {g.children.map((c, i) => c.type === "group"
        ? <GroupEditor key={i} g={c} meta={meta} depth={depth + 1} onChange={(r) => set(i, r)} onRemove={() => del(i)} />
        : <Cond key={i} r={c} meta={meta} onChange={(r) => set(i, r)} onRemove={() => del(i)} />)}
    </div>
  );
}

type Est = { count: number; total: number; share: number; description: string; sample: Array<Record<string, unknown>> };

export function SegmentBuilder({ rules, setRules, onSaved }: { rules: Rule; setRules: (r: Rule) => void; onSaved?: (id: string) => void }) {
  const meta = useApi<Meta>("segments/fields");
  const { toast } = useGlobal();
  const [purpose, setPurpose] = useState("service");
  const [type, setType] = useState("dynamic");
  const [name, setName] = useState("");
  const [est, setEst] = useState<Est | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    const tm = setTimeout(() => api<Est>("segments/estimate", { body: { rules, purpose }, signal: c.signal }).then((e) => { setEst(e); setErr(null); }).catch((e) => { if (e.name !== "AbortError") setErr(e.message); }), 400);
    return () => { clearTimeout(tm); c.abort(); };
  }, [rules, purpose]);
  const save = async () => {
    if (!name.trim()) { toast({ kind: "warning", title: "Name the segment first" }); return; }
    setSaving(true);
    try { const s = await api<{ id: string; member_count: number }>("segments", { body: { name, type, purpose, rules } }); toast({ kind: "success", title: "Segment saved", body: `${fmt.int(s.member_count)} members` }); onSaved?.(s.id); }
    catch (e) { toast({ kind: "error", title: "Save failed", body: (e as Error).message }); }
    setSaving(false);
  };
  if (!meta.data) return <div className="skeleton h-40" />;
  const promo = purpose === "membership" || purpose === "marketing";
  return (
    <div className="grid lg:grid-cols-3 gap-3">
      <div className="lg:col-span-2 space-y-3">
        <Card title="Rules" subtitle="Nested AND/OR groups · attributes, event counts, tags, segment set operations, attribute history">
          {rules.type === "group" ? <GroupEditor g={rules} meta={meta.data} onChange={setRules} /> : <Notice>Root rule must be a group.</Notice>}
        </Card>
      </div>
      <div className="space-y-3">
        <Card title="Estimated audience">
          {err && <Notice tone="bad">{err}</Notice>}
          {est ? <div className="space-y-2">
            <div className="text-[26px] font-semibold tabular-nums">{fmt.int(est.count)}</div>
            <div className="text-xs text-muted">{fmt.pct(est.share)} of {fmt.int(est.total)} profiles</div>
            <code className="block text-[11.5px] font-mono bg-panel-2 border border-border rounded p-2 break-words">{est.description}</code>
            {promo && <Notice tone="warn">Promotional purpose: mandatory compliance exclusions (self-exclusion, RG restriction, opt-out, inactive accounts) are applied automatically and cannot be overridden.</Notice>}
          </div> : <div className="skeleton h-20" />}
        </Card>
        <Card title="Save segment">
          <div className="space-y-2">
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Launch failures + open ticket" /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Type"><Select value={type} onChange={(e) => setType(e.target.value)} options={["dynamic", "realtime", "static"]} /></Field>
              <Field label="Purpose"><Select value={purpose} onChange={(e) => setPurpose(e.target.value)} options={["service", "security", "operational", "protective", "membership", "marketing"]} /></Field>
            </div>
            <div className="text-[11px] text-faint">Dynamic/realtime segments add and remove members automatically and publish entry/exit events to journeys. Static segments freeze after the first evaluation.</div>
            <Button variant="primary" onClick={save} loading={saving} className="w-full">Save segment</Button>
          </div>
        </Card>
        {est && <Card title="Sample matching players" pad={false}>
          <div className="divide-y divide-border">{est.sample.map((s) => <a key={String(s.player_id)} href={`/audience/${s.player_id}`} className="flex items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-panel-2"><span className="font-mono">{String(s.player_id)}</span><span className="text-muted truncate flex-1">{String(s.kyc_status)} · {String(s.vip_tier)} · {String(s.primary_platform)}</span></a>)}
            {!est.sample.length && <div className="p-3 text-xs text-muted">No matches</div>}</div>
        </Card>}
      </div>
    </div>
  );
}
