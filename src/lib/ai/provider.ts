/**
 * Unified AI provider interface. Credentials are read from server-side env only and never sent to the browser.
 * Supported: mock (default, deterministic, no network), anthropic, openai, openai_compatible (DeepSeek, Ollama, Gemini-compat, ...).
 */
export type ToolDef = { name: string; description: string; parameters: Record<string, unknown> };
export type ChatMsg =
  | { role: "user" | "assistant"; content: string }
  | { role: "assistant_tool_calls"; content: string; calls: Array<{ id: string; name: string; args: Record<string, unknown> }> }
  | { role: "tool"; call_id: string; name: string; content: string };
export type StreamChunk = { type: "text"; text: string } | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> } | { type: "done"; stop: "end" | "tool_use" };

export type ProviderInfo = { id: string; label: string; configured: boolean; model: string | null };

export function providerStatus(): ProviderInfo[] {
  return [
    { id: "mock", label: "Mock (deterministic, offline)", configured: true, model: "aec-mock-1" },
    { id: "anthropic", label: "Anthropic", configured: !!process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5" },
    { id: "openai", label: "OpenAI", configured: !!process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini" },
    { id: "openai_compatible", label: "OpenAI-compatible (DeepSeek / Ollama / Gemini)", configured: !!process.env.OPENAI_COMPATIBLE_BASE_URL, model: process.env.OPENAI_COMPATIBLE_MODEL ?? null },
  ];
}

export function activeProvider(): string {
  const p = process.env.AEC_AI_PROVIDER ?? "mock";
  const st = providerStatus().find((x) => x.id === p);
  return st?.configured ? p : "mock";
}

async function* sseLines(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line.startsWith("data:")) yield line.slice(5).trim(); }
  }
}

export async function* streamLLM(provider: string, system: string, messages: ChatMsg[], tools: ToolDef[], signal?: AbortSignal): AsyncGenerator<StreamChunk> {
  if (provider === "anthropic") {
    const body = {
      model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5", max_tokens: 2048, system, stream: true,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      messages: messages.map((m) => m.role === "tool" ? { role: "user", content: [{ type: "tool_result", tool_use_id: m.call_id, content: m.content }] }
        : m.role === "assistant_tool_calls" ? { role: "assistant", content: [...(m.content ? [{ type: "text", text: m.content }] : []), ...m.calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args }))] }
        : { role: m.role, content: m.content }),
    };
    const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal, headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const pending = new Map<number, { id: string; name: string; json: string }>();
    let stop: "end" | "tool_use" = "end";
    for await (const d of sseLines(res)) {
      const ev = JSON.parse(d);
      if (ev.type === "content_block_start" && ev.content_block.type === "tool_use") pending.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, json: "" });
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") yield { type: "text", text: ev.delta.text };
      if (ev.type === "content_block_delta" && ev.delta.type === "input_json_delta") pending.get(ev.index)!.json += ev.delta.partial_json;
      if (ev.type === "content_block_stop" && pending.has(ev.index)) { const p = pending.get(ev.index)!; yield { type: "tool_call", id: p.id, name: p.name, args: p.json ? JSON.parse(p.json) : {} }; }
      if (ev.type === "message_delta" && ev.delta.stop_reason === "tool_use") stop = "tool_use";
    }
    yield { type: "done", stop };
    return;
  }
  // OpenAI + compatible
  const base = provider === "openai" ? "https://api.openai.com/v1" : process.env.OPENAI_COMPATIBLE_BASE_URL!;
  const key = provider === "openai" ? process.env.OPENAI_API_KEY : process.env.OPENAI_COMPATIBLE_API_KEY;
  const model = provider === "openai" ? process.env.OPENAI_MODEL ?? "gpt-4.1-mini" : process.env.OPENAI_COMPATIBLE_MODEL!;
  const body = {
    model, stream: true, tools: tools.map((t) => ({ type: "function", function: t })),
    messages: [{ role: "system", content: system }, ...messages.map((m) => m.role === "tool" ? { role: "tool", tool_call_id: m.call_id, content: m.content }
      : m.role === "assistant_tool_calls" ? { role: "assistant", content: m.content || null, tool_calls: m.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
      : m)],
  };
  const res = await fetch(`${base}/chat/completions`, { method: "POST", signal, headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${provider} error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let stop: "end" | "tool_use" = "end";
  for await (const d of sseLines(res)) {
    if (d === "[DONE]") break;
    const ev = JSON.parse(d); const ch = ev.choices?.[0];
    if (!ch) continue;
    if (ch.delta?.content) yield { type: "text", text: ch.delta.content };
    for (const tc of ch.delta?.tool_calls ?? []) {
      const cur = calls.get(tc.index) ?? { id: tc.id ?? "", name: "", args: "" };
      if (tc.id) cur.id = tc.id; if (tc.function?.name) cur.name = tc.function.name; if (tc.function?.arguments) cur.args += tc.function.arguments;
      calls.set(tc.index, cur);
    }
    if (ch.finish_reason === "tool_calls") stop = "tool_use";
  }
  for (const c of calls.values()) yield { type: "tool_call", id: c.id, name: c.name, args: c.args ? JSON.parse(c.args) : {} };
  yield { type: "done", stop: calls.size ? "tool_use" : stop };
}

/** One-shot completion used by agents for narrative explanations (falls back to the deterministic text). */
export async function narrate(fallback: string, instruction: string, evidence: unknown): Promise<{ text: string; provider: string; tokens: number }> {
  const p = activeProvider();
  const approxTokens = Math.ceil((JSON.stringify(evidence).length + fallback.length) / 4);
  if (p === "mock") return { text: fallback, provider: "mock", tokens: approxTokens };
  try {
    let out = "";
    for await (const c of streamLLM(p, "You are an operations analyst. Be concise and factual; only use the evidence provided. Distinguish verified data from assumptions.", [{ role: "user", content: `${instruction}\n\nEvidence JSON:\n${JSON.stringify(evidence).slice(0, 6000)}` }], [])) if (c.type === "text") out += c.text;
    return { text: out || fallback, provider: p, tokens: approxTokens + Math.ceil(out.length / 4) };
  } catch (e) { return { text: `${fallback}\n(LLM unavailable: ${(e as Error).message.slice(0, 80)} — deterministic summary shown)`, provider: "mock", tokens: approxTokens }; }
}
