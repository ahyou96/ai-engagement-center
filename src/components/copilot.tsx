"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bot, Send, Square, RotateCcw, Wrench, CheckCircle2, Download, Plus, X, Maximize2, Trash2, Database } from "lucide-react";
import { api, downloadCsv, useApi, useGlobal } from "./hooks";
import { Badge, Button, cx, Confirm, Notice, Textarea } from "./ui";
import { Chart, bar, line, pie } from "./chart";

type Part = { type: string; [k: string]: unknown };
type Msg = { id: string; role: "user" | "assistant"; content: string; parts: Part[]; status?: string; provider?: string };

/** Minimal, safe markdown: escapes HTML, then supports **bold**, _italic_, `code`, lists, paragraphs. */
function md(s: string) {
  const esc = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.split(/\n{2,}/).map((block) => {
    const inline = (x: string) => x.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/(^|\s)_(.+?)_(?=\s|$|[.,])/g, "$1<em>$2</em>").replace(/`([^`]+)`/g, "<code>$1</code>");
    if (/^\s*- /m.test(block)) { const lines = block.split("\n"); const pre = lines.filter((l) => !/^\s*- /.test(l)); const li = lines.filter((l) => /^\s*- /.test(l)).map((l) => `<li>${inline(l.replace(/^\s*- /, ""))}</li>`); return `${pre.length ? `<p>${inline(pre.join(" "))}</p>` : ""}<ul>${li.join("")}</ul>`; }
    return `<p>${inline(block).replace(/\n/g, "<br/>")}</p>`;
  }).join("");
}

export function useCopilotChat() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const ctrl = useRef<AbortController | null>(null);

  const send = useCallback(async (text: string) => {
    if (!text.trim() || busy) return;
    const uid = `u${Date.now()}`, aid = `a${Date.now()}`;
    setMessages((m) => [...m, { id: uid, role: "user", content: text, parts: [] }, { id: aid, role: "assistant", content: "", parts: [], status: "streaming" }]);
    setBusy(true);
    const c = new AbortController(); ctrl.current = c;
    const patch = (f: (m: Msg) => Msg) => setMessages((ms) => ms.map((m) => (m.id === aid ? f(m) : m)));
    try {
      const res = await fetch("/api/copilot/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: text, conversation_id: conversationId }), signal: c.signal });
      if (!res.ok || !res.body) { const e = await res.json().catch(() => ({ error: res.statusText })); throw new Error(e.error); }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const data = chunk.split("\n").find((l) => l.startsWith("data: "))?.slice(6); if (!data) continue;
          const p = JSON.parse(data) as Part;
          if (p.type === "meta") { setConversationId(String(p.conversation_id)); patch((m) => ({ ...m, provider: String(p.provider) })); }
          else if (p.type === "text") patch((m) => ({ ...m, content: m.content + String(p.text) }));
          else if (p.type === "tool_end") patch((m) => ({ ...m, parts: m.parts.map((x) => (x.type === "tool_start" && x.id === p.id ? { ...p, type: "tool_end" } : x)) }));
          else if (p.type === "done") patch((m) => ({ ...m, status: "complete" }));
          else if (p.type === "error") patch((m) => ({ ...m, status: "error", parts: [...m.parts, p] }));
          else patch((m) => ({ ...m, parts: [...m.parts, p] }));
        }
      }
    } catch (e) {
      patch((m) => ({ ...m, status: c.signal.aborted ? "cancelled" : "error", parts: c.signal.aborted ? m.parts : [...m.parts, { type: "error", message: (e as Error).message }] }));
    } finally { setBusy(false); ctrl.current = null; }
  }, [busy, conversationId]);

  const stop = () => ctrl.current?.abort();
  const regenerate = () => { const lastUser = [...messages].reverse().find((m) => m.role === "user"); if (!lastUser) return; setMessages((ms) => ms.slice(0, -2)); setTimeout(() => send(lastUser.content), 0); };
  const load = async (id: string) => { const r = await api<{ messages: Array<{ id: string; role: "user" | "assistant"; content: string; parts: Part[]; status: string; provider: string }> }>(`copilot/conversations/${id}`); setConversationId(id); setMessages(r.messages); };
  const reset = () => { setMessages([]); setConversationId(undefined); };
  return { messages, send, stop, regenerate, busy, conversationId, load, reset };
}

const SUGGESTED = [
  "Which gaming providers have launch failures today?",
  "Find users who experienced game loading failures in the last seven days and have unresolved customer service tickets.",
  "How is KYC completion looking? Where do players get stuck?",
  "Compare SMS delivery with other channels this week",
  "Show the strategy history for KYC assistance",
  "Simulate membership entitlement eligibility",
];

export function ChatView({ chat, compact }: { chat: ReturnType<typeof useCopilotChat>; compact?: boolean }) {
  const [input, setInput] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [chat.messages]);
  const { t } = useGlobal();
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 overflow-y-auto scroll-thin px-4 py-4 space-y-4">
        {!chat.messages.length && (
          <div className="py-6">
            <div className="flex items-center gap-2 text-[15px] font-semibold"><Bot size={18} className="text-accent" />How can I help?</div>
            <p className="text-xs text-muted mt-1">I query platform data with tools, show my tool calls and sources, and label figures as verified, estimates or assumptions. Drafts are never saved without your confirmation.</p>
            <div className={cx("grid gap-2 mt-4", compact ? "grid-cols-1" : "sm:grid-cols-2")}>{SUGGESTED.map((s) => <button key={s} onClick={() => chat.send(s)} className="text-left rounded-md border border-border px-3 py-2 text-[12.5px] hover:border-accent hover:bg-accent-soft/30">{s}</button>)}</div>
          </div>
        )}
        {chat.messages.map((m) => <MessageView key={m.id} m={m} onFollowUp={chat.send} />)}
        <div ref={end} />
      </div>
      <div className="border-t border-border p-3">
        <div className="flex gap-2 items-end">
          <Textarea value={input} onChange={(e) => setInput(e.target.value)} rows={compact ? 2 : 2} placeholder="Ask about players, games, campaigns, strategies…  (Enter to send, Shift+Enter for newline)" className="flex-1 resize-none"
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); chat.send(input); setInput(""); } }} aria-label="Message" />
          {chat.busy ? <Button onClick={chat.stop} aria-label={t("stop")}><Square size={13} />{t("stop")}</Button> : <Button variant="primary" onClick={() => { chat.send(input); setInput(""); }} disabled={!input.trim()}><Send size={13} />{t("send")}</Button>}
        </div>
        <div className="flex items-center gap-2 mt-2 text-[11px] text-faint">
          {chat.messages.length > 0 && !chat.busy && <button className="flex items-center gap-1 hover:text-fg" onClick={chat.regenerate}><RotateCcw size={11} />{t("regenerate")}</button>}
          {chat.messages.length > 0 && <button className="flex items-center gap-1 hover:text-fg" onClick={() => { const blob = new Blob([chat.messages.map((m) => `## ${m.role}\n\n${m.content}`).join("\n\n")], { type: "text/markdown" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "copilot-conversation.md"; a.click(); }}><Download size={11} />Export</button>}
          <span className="ml-auto">Restricted actions always require human approval</span>
        </div>
      </div>
    </div>
  );
}

function MessageView({ m, onFollowUp }: { m: Msg; onFollowUp: (s: string) => void }) {
  if (m.role === "user") return <div className="flex justify-end"><div className="max-w-[85%] rounded-lg bg-accent text-accent-fg px-3 py-2 text-[13px] whitespace-pre-wrap">{m.content}</div></div>;
  const tools = m.parts.filter((p) => p.type === "tool_start" || p.type === "tool_end");
  const rest = m.parts.filter((p) => !["tool_start", "tool_end", "meta", "suggestions"].includes(p.type));
  const sugg = m.parts.find((p) => p.type === "suggestions") as { items: string[] } | undefined;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[11px] text-faint"><Bot size={13} className="text-accent" />Copilot{m.provider && <Badge tone={m.provider === "mock" ? "warn" : "info"}>{m.provider === "mock" ? "simulated AI (mock)" : m.provider}</Badge>}{m.status === "cancelled" && <Badge>cancelled</Badge>}</div>
      {tools.length > 0 && <div className="space-y-1">{tools.map((tl, i) => (
        <div key={i} className="flex items-center gap-2 text-[12px] rounded-md border border-border bg-panel-2 px-2.5 py-1.5">
          {tl.type === "tool_start" ? <span className="h-3 w-3 rounded-full border-2 border-accent border-t-transparent animate-spin" /> : <CheckCircle2 size={13} className="text-ok" />}
          <Wrench size={12} className="text-faint" /><code className="font-mono text-[11.5px]">{String(tl.name)}</code>
          <span className="text-muted truncate flex-1">{tl.type === "tool_end" ? String(tl.summary) : "running…"}</span>
          {tl.type === "tool_end" && <span className="text-faint flex items-center gap-1 shrink-0" title={(tl.sources as string[]).join(", ")}><Database size={11} />{(tl.sources as string[]).length} source{(tl.sources as string[]).length === 1 ? "" : "s"} · {String(tl.ms)}ms</span>}
        </div>))}</div>}
      {(m.content || m.status === "streaming") && <div className="prose-ai text-[13px] leading-relaxed" dangerouslySetInnerHTML={{ __html: md(m.content) + (m.status === "streaming" ? '<span class="inline-block w-1.5 h-3.5 bg-accent align-middle pulse ml-0.5"></span>' : "") }} />}
      {rest.map((p, i) => <PartView key={i} p={p} />)}
      {sugg && m.status === "complete" && <div className="flex flex-wrap gap-1.5">{sugg.items.map((s) => <button key={s} onClick={() => onFollowUp(s)} className="text-[12px] rounded-full border border-border px-2.5 py-1 hover:border-accent hover:text-accent">{s}</button>)}</div>}
    </div>
  );
}

function PartView({ p }: { p: Part }) {
  const router = useRouter(); const { toast } = useGlobal();
  const [confirm, setConfirm] = useState(false); const [saving, setSaving] = useState(false);
  if (p.type === "error") return <Notice tone="bad">{String(p.message)}</Notice>;
  if (p.type === "notice") return <Notice tone={p.level === "warning" ? "warn" : "info"}>{String(p.text)}</Notice>;
  if (p.type === "table") {
    const cols = p.columns as string[]; const rows = p.rows as unknown[][];
    return (
      <div className="rounded-md border border-border overflow-hidden">
        <div className="flex items-center gap-2 px-2.5 py-1.5 bg-panel-2 border-b border-border text-[12px]"><span className="font-medium flex-1 truncate">{String(p.title)}</span><Badge tone={p.kind === "verified" ? "ok" : "info"}>{String(p.kind)}</Badge><button className="text-faint hover:text-fg" aria-label="Export table" onClick={() => downloadCsv(String(p.title), rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]]))))}><Download size={12} /></button></div>
        <div className="overflow-x-auto scroll-thin"><table className="w-full text-[12px]"><thead className="text-muted"><tr>{cols.map((c) => <th key={c} className="text-left font-medium px-2.5 py-1.5 whitespace-nowrap">{c}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-border">{r.map((v, j) => <td key={j} className="px-2.5 py-1.5 whitespace-nowrap">{String(v ?? "–")}</td>)}</tr>)}</tbody></table></div>
        <div className="px-2.5 py-1 text-[10.5px] text-faint border-t border-border">Source: {String(p.source)}</div>
      </div>
    );
  }
  if (p.type === "chart") {
    const x = p.x as string[]; const series = p.series as Array<{ name: string; data: number[] }>;
    const opt = p.chartType === "pie" ? pie(x.map((n, i) => ({ name: n, value: series[0].data[i] }))) : p.chartType === "line" ? line(x, series) : bar(x, series);
    return <div className="rounded-md border border-border p-2"><div className="text-[12px] font-medium mb-1">{String(p.title)}</div><Chart option={opt} height={220} /><div className="text-[10.5px] text-faint">Source: {String(p.source)}</div></div>;
  }
  if (p.type === "draft") {
    const pl = p.payload as Record<string, unknown>;
    const save = async () => {
      setSaving(true);
      try {
        if (p.kind === "segment") { const s = await api<{ id: string; member_count: number }>("segments", { body: { name: String(pl.name), description: `AI-generated: ${pl.description}`, type: "dynamic", purpose: pl.purpose ?? "service", rules: pl.rules, ai_generated: true } }); toast({ kind: "success", title: "Segment saved", body: `${s.member_count} members` }); router.push(`/audience?tab=segments&id=${s.id}`); }
        if (p.kind === "campaign") router.push(`/campaigns?new=1&segment=${pl.segment_id ?? ""}&template=${pl.template_id ?? ""}&name=${encodeURIComponent(String(pl.name))}`);
        if (p.kind === "journey") router.push(`/journeys`);
      } catch (e) { toast({ kind: "error", title: "Could not save", body: (e as Error).message }); }
      setSaving(false); setConfirm(false);
    };
    return (
      <div className="rounded-md border border-accent/40 bg-accent-soft/30 p-3 space-y-2">
        <div className="flex items-center gap-2"><Badge tone="accent">draft · {String(p.kind)}</Badge><span className="text-[12.5px] font-medium truncate">{String(p.title)}</span></div>
        {p.kind === "segment" && <div className="text-[12px] space-y-1"><div><span className="text-muted">Rules:</span> <code className="font-mono text-[11.5px]">{String(pl.description)}</code></div><div><span className="text-muted">Purpose:</span> {String(pl.purpose)} · <span className="text-muted">Estimated:</span> {Number(pl.estimated).toLocaleString()} players</div></div>}
        {p.kind === "campaign" && <div className="text-[12px] space-y-1"><div><span className="text-muted">Channel:</span> {(pl.channels as string[]).join(", ")} · <span className="text-muted">Audience:</span> {String(pl.segment_name ?? "choose in wizard")}</div><div className="text-muted italic">“{String(pl.template_preview ?? "")}”</div></div>}
        {p.kind === "journey" && <ol className="text-[12px] list-decimal pl-4">{(pl.steps as string[]).map((s) => <li key={s}>{s}</li>)}</ol>}
        <div className="flex gap-2"><Button size="sm" variant="primary" onClick={() => setConfirm(true)}>{p.kind === "segment" ? "Review & save segment" : p.kind === "campaign" ? "Open in campaign wizard" : "Open Journey Builder"}</Button></div>
        <Confirm open={confirm} onClose={() => setConfirm(false)} onConfirm={save} loading={saving} title={`Confirm ${p.kind}`} confirmLabel={p.kind === "segment" ? "Save segment" : "Continue"}
          body={p.kind === "segment" ? `This saves a dynamic segment (${Number(pl.estimated).toLocaleString()} players today). Membership updates automatically; mandatory compliance exclusions apply at execution time.` : "You will review and validate everything before anything is submitted for approval."} />
      </div>
    );
  }
  return null;
}

/** Global copilot side panel (⌘J). */
export function CopilotPanel({ open, prompt, nonce, onClose }: { open: boolean; prompt?: string; nonce: number; onClose: () => void }) {
  const chat = useCopilotChat(); const router = useRouter();
  const sent = useRef(0);
  useEffect(() => { if (open && prompt && sent.current !== nonce) { sent.current = nonce; chat.send(prompt); } }, [open, prompt, nonce, chat]);
  if (!open) return null;
  return (
    <aside className="fixed inset-y-0 right-0 z-30 w-full sm:w-[440px] bg-panel border-l border-border shadow-2xl flex flex-col" aria-label="AI Copilot">
      <div className="h-12 border-b border-border flex items-center gap-2 px-3"><Bot size={16} className="text-accent" /><span className="font-semibold text-[13px] flex-1">AI Copilot</span>
        <button className="p-1 rounded hover:bg-panel-2 text-muted" aria-label="New conversation" onClick={chat.reset}><Plus size={15} /></button>
        <button className="p-1 rounded hover:bg-panel-2 text-muted" aria-label="Open full page" onClick={() => { onClose(); router.push(`/copilot${chat.conversationId ? `?c=${chat.conversationId}` : ""}`); }}><Maximize2 size={14} /></button>
        <button className="p-1 rounded hover:bg-panel-2 text-muted" aria-label="Close" onClick={onClose}><X size={15} /></button></div>
      <ChatView chat={chat} compact />
    </aside>
  );
}

/** Full-page copilot with conversation history. */
export function CopilotPage({ initial }: { initial?: string | null }) {
  const chat = useCopilotChat(); const convs = useApi<Array<{ id: string; title: string; updated_at: string }>>("copilot/conversations", [chat.conversationId, chat.busy]);
  const [del, setDel] = useState<string | null>(null); const { t } = useGlobal();
  useEffect(() => { if (initial) chat.load(initial); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [initial]);
  return (
    <div className="flex h-[calc(100dvh-88px)] rounded-lg border border-border bg-panel overflow-hidden">
      <div className="hidden md:flex w-60 border-r border-border flex-col">
        <div className="p-2 border-b border-border"><Button className="w-full" onClick={chat.reset}><Plus size={14} />{t("new_chat")}</Button></div>
        <div className="flex-1 overflow-y-auto scroll-thin p-1">{(convs.data ?? []).map((c) => (
          <div key={c.id} className={cx("group flex items-center rounded-md", chat.conversationId === c.id ? "bg-accent-soft" : "hover:bg-panel-2")}>
            <button onClick={() => chat.load(c.id)} className="flex-1 text-left px-2.5 py-2 text-[12.5px] truncate">{c.title}</button>
            <button aria-label="Delete conversation" onClick={() => setDel(c.id)} className="opacity-0 group-hover:opacity-100 p-1.5 text-faint hover:text-bad"><Trash2 size={12} /></button>
          </div>))}</div>
      </div>
      <div className="flex-1 min-w-0"><ChatView chat={chat} /></div>
      <Confirm open={!!del} onClose={() => setDel(null)} danger title="Delete conversation?" body="This removes the conversation history for you." confirmLabel="Delete" onConfirm={async () => { await api(`copilot/conversations/${del}`, { method: "DELETE" }); if (chat.conversationId === del) chat.reset(); setDel(null); convs.refresh(); }} />
    </div>
  );
}
