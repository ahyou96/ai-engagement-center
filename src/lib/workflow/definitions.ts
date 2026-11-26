export const AGENTS = [
  { key: "data_intel", name: "Data Intelligence Agent", description: "Queries BI/event data, computes baseline metrics and data freshness", tools: ["sql.query", "bi.metrics", "events.ingest"] },
  { key: "discovery", name: "Opportunity Discovery Agent", description: "Applies the active strategy's detection rules to surface opportunities", tools: ["opportunities.upsert"] },
  { key: "gaming_intel", name: "Gaming Intelligence Agent", description: "Game, provider, device and experience analysis (no wagering-intensity targeting)", tools: ["sql.query"] },
  { key: "customer_intel", name: "Customer Intelligence Agent", description: "Affected-population profile, consent coverage, service history", tools: ["sql.query", "cdp.profile"] },
  { key: "root_cause", name: "Root Cause Analysis Agent", description: "Ranks hypotheses with supporting evidence and confidence", tools: ["sql.query", "llm.narrate"] },
  { key: "decision", name: "Decision Agent", description: "Proposes candidate actions with risk classification", tools: [] },
  { key: "audience", name: "Audience Segmentation Agent", description: "Creates or reuses structured dynamic segments", tools: ["segments.create", "segments.estimate"] },
  { key: "offer_eligibility", name: "Offer Eligibility Agent", description: "Runs the deterministic entitlement engine (simulation first)", tools: ["offers.simulate"] },
  { key: "campaign", name: "Campaign Agent", description: "Drafts communications using approved templates and channels", tools: ["templates.select", "channels.route"] },
  { key: "journey", name: "Journey Planning Agent", description: "Plans or versions automation journeys pinned to the strategy", tools: ["journeys.plan"] },
  { key: "compliance", name: "Compliance Agent", description: "Runs the mandatory policy engine — cannot be skipped", tools: ["compliance.evaluate", "compliance.content"] },
  { key: "approval", name: "Approval Gateway (policy engine)", description: "Deterministic policy: auto-execute only authorized low-risk actions", tools: ["policy.evaluate", "approvals.create"] },
  { key: "execution", name: "Execution Agent", description: "Executes approved actions through idempotent platform APIs (mock sending)", tools: ["messages.send", "tickets.create", "offers.issue", "journeys.enroll"] },
  { key: "analytics", name: "Analytics Agent", description: "Collects outcomes and records strategy evaluation data", tools: ["sql.query"] },
  { key: "optimizer", name: "Strategy Optimizer Agent", description: "Historical replay + statistical test → candidate strategy version", tools: ["strategy.replay", "strategy.candidate", "stats.ztest"] },
] as const;

export type NodeDef = { key: string; agent: string; after: string[]; applies?: boolean; note?: string };
const base = (na: Record<string, string>): NodeDef[] => {
  const n = (key: string, after: string[]): NodeDef => ({ key, agent: key, after, applies: !(key in na), note: na[key] });
  return [
    n("data_intel", []), n("discovery", ["data_intel"]), n("gaming_intel", ["discovery"]), n("customer_intel", ["discovery"]),
    n("root_cause", ["gaming_intel", "customer_intel"]), n("decision", ["root_cause"]), n("audience", ["decision"]),
    n("offer_eligibility", ["audience"]), n("campaign", ["offer_eligibility"]), n("journey", ["offer_eligibility"]),
    n("compliance", ["campaign", "journey"]), n("approval", ["compliance"]), n("execution", ["approval"]),
    n("analytics", ["execution"]), n("optimizer", ["analytics"]),
  ];
};

export const WORKFLOWS: Record<string, { id: string; name: string; description: string; strategy: string; nodes: NodeDef[] }> = {
  provider_failure: { id: "wf_provider_failure", name: "Gaming Provider Failure Response", description: "Scenario A — detect provider launch failures, investigate, notify affected players", strategy: "provider_monitoring",
    nodes: base({ offer_eligibility: "No entitlement in this strategy version", journey: "One-off notification; no journey needed" }) },
  kyc_assistance: { id: "wf_kyc_assistance", name: "KYC Service Assistance", description: "Scenario B — detect KYC breakpoints and run a service guidance journey", strategy: "kyc_assistance",
    nodes: base({ gaming_intel: "Not applicable to KYC", offer_eligibility: "No entitlement — service guidance only", campaign: "Handled by journey" }) },
  membership_entitlements: { id: "wf_membership_entitlements", name: "Personalized Membership Entitlements", description: "Scenario C — deterministic membership benefit decisions within budget", strategy: "membership_entitlements",
    nodes: base({ gaming_intel: "Excluded by policy: gaming/wagering data is never an entitlement input", root_cause: "Scheduled cycle — no incident", campaign: "No message required", journey: "No journey required" }) },
  channel_delivery: { id: "wf_channel_delivery", name: "Channel Delivery Recovery", description: "Scenario D — detect SMS degradation and recover via consented fallback channels", strategy: "channel_routing",
    nodes: base({ gaming_intel: "Not applicable", offer_eligibility: "Not applicable", journey: "Not applicable" }) },
  rg_protection: { id: "wf_rg_protection", name: "Responsible Gaming Protection", description: "Scenario E — enforce and verify protective exclusion end-to-end", strategy: "rg_protection",
    nodes: base({ gaming_intel: "Not used — protection never depends on gaming intensity", root_cause: "Not applicable", offer_eligibility: "Incentives are blocked, not evaluated", campaign: "No promotional communication" }) },
};
export const workflowByScenario = (s: string) => WORKFLOWS[s];
export const workflowById = (id: string) => Object.entries(WORKFLOWS).find(([, w]) => w.id === id);
