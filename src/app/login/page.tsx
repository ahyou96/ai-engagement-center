"use client";
import { useEffect, useState } from "react";

const DEMO = [
  ["admin@aec.local", "Administrator"], ["ops@aec.local", "Operations Manager (approver)"], ["crm@aec.local", "CRM Specialist"], ["compliance@aec.local", "Compliance Officer (approver)"],
  ["analyst@aec.local", "Data Analyst (no PII)"], ["cs@aec.local", "Customer Service"], ["finance@aec.local", "Finance"],
];
export default function Login() {
  const [demo, setDemo] = useState(false);
  useEffect(() => { fetch("/api/auth/config").then((r) => r.json()).then((c) => setDemo(!!c.demo_logins)).catch(() => {}); }, []);
  const [email, setEmail] = useState("admin@aec.local"); const [password, setPassword] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (e?: React.FormEvent, as?: string) => {
    e?.preventDefault(); setBusy(true); setErr("");
    const res = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: as ?? email, password: as ? "demo1234" : password }) });
    if (res.ok) window.location.href = "/overview"; else { setErr((await res.json()).error ?? "Login failed"); setBusy(false); }
  };
  return (
    <div className="min-h-dvh grid place-items-center px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="flex items-center gap-2 mb-6"><div className="h-8 w-8 rounded-md bg-accent text-accent-fg grid place-items-center text-xs font-bold">AE</div><div><div className="font-semibold">AI Engagement Center</div><div className="text-xs text-muted">Local demo · synthetic data · mock sending</div></div></div>
        <form onSubmit={submit} className="rounded-lg border border-border bg-panel p-5 space-y-3">
          <label className="block text-xs"><span className="text-muted font-medium">Email</span><input className="mt-1 h-9 w-full rounded-md border border-border bg-panel px-2.5 text-[13px] outline-none focus:border-accent" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></label>
          <label className="block text-xs"><span className="text-muted font-medium">Password</span><input type="password" className="mt-1 h-9 w-full rounded-md border border-border bg-panel px-2.5 text-[13px] outline-none focus:border-accent" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
          {err && <div className="text-xs text-bad">{err}</div>}
          <button disabled={busy} className="h-9 w-full rounded-md bg-accent text-accent-fg text-[13px] font-medium disabled:opacity-60">{busy ? "Signing in…" : "Sign in"}</button>
        </form>
        {demo && <div className="mt-5 rounded-lg border border-border bg-panel p-4">
          <div className="text-xs font-medium mb-2">Demo accounts <span className="text-faint font-normal">(local only — password shown in README)</span></div>
          <div className="grid gap-1">{DEMO.map(([e, r]) => <button key={e} onClick={() => submit(undefined, e)} className="flex justify-between text-left text-[12.5px] rounded px-2 py-1.5 hover:bg-panel-2"><span>{e}</span><span className="text-muted text-xs">{r}</span></button>)}</div>
        </div>}
      </div>
    </div>
  );
}
