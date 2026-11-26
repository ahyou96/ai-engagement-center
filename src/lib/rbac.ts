export const PERMISSIONS = [
  "dashboard.read", "copilot.use", "opportunities.read", "workflows.run", "workflows.control", "workflows.emergency_stop",
  "audience.read", "audience.write", "pii.read", "finance.read", "gaming_transactions.read", "risk.read",
  "segments.write", "tags.write", "identity.merge", "events.ingest",
  "offers.read", "offers.write", "offers.issue", "budgets.write",
  "campaigns.read", "campaigns.write", "campaigns.execute", "journeys.read", "journeys.write", "journeys.publish",
  "channels.read", "channels.write", "templates.write", "analytics.read",
  "strategies.read", "strategies.write", "strategies.activate",
  "compliance.read", "compliance.write", "approvals.decide", "audit.read", "settings.read", "settings.write",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ_ALL: Permission[] = ["dashboard.read", "copilot.use", "opportunities.read", "audience.read", "offers.read", "campaigns.read", "journeys.read", "channels.read", "analytics.read", "strategies.read", "compliance.read"];

export const ROLES: Record<string, { name: string; description: string; permissions: Permission[] }> = {
  admin: { name: "Administrator", description: "Full platform access including settings and emergency stop", permissions: [...PERMISSIONS] },
  ops_manager: {
    name: "Operations Manager", description: "Runs AI workflows, approves operational actions",
    permissions: [...READ_ALL, "workflows.run", "workflows.control", "workflows.emergency_stop", "approvals.decide", "segments.write", "tags.write", "campaigns.write", "campaigns.execute", "journeys.write", "journeys.publish", "strategies.write", "strategies.activate", "pii.read", "events.ingest", "templates.write", "offers.write", "offers.issue", "budgets.write", "audit.read", "settings.read"],
  },
  marketer: {
    name: "CRM / Engagement Specialist", description: "Builds segments, campaigns, journeys; cannot approve own work",
    permissions: [...READ_ALL, "segments.write", "tags.write", "campaigns.write", "journeys.write", "templates.write", "offers.write", "workflows.run"],
  },
  analyst: { name: "Data Analyst", description: "Read-only analytics; no PII", permissions: [...READ_ALL] },
  cs_agent: { name: "Customer Service Agent", description: "Customer 360 with PII for service", permissions: ["dashboard.read", "copilot.use", "audience.read", "pii.read", "opportunities.read", "analytics.read"] },
  compliance_officer: {
    name: "Compliance Officer", description: "Policies, approvals, audit, restricted data for RG/compliance purposes",
    permissions: [...READ_ALL, "compliance.write", "approvals.decide", "audit.read", "pii.read", "risk.read", "gaming_transactions.read", "workflows.emergency_stop", "workflows.control", "identity.merge", "settings.read"],
  },
  finance: { name: "Finance / Accounting", description: "Budgets and restricted financial data", permissions: [...READ_ALL, "finance.read", "gaming_transactions.read", "budgets.write", "approvals.decide", "audit.read"] },
};

export function can(role: string, p: Permission) {
  return ROLES[role]?.permissions.includes(p) ?? false;
}

/** Field-level masking. Restricted fields are removed or masked unless the role holds the permission. */
const FIELD_RULES: Record<string, Permission> = {
  email: "pii.read", phone: "pii.read", birth_date: "pii.read", display_name: "pii.read",
  deposit_count: "finance.read", deposit_total: "finance.read", withdrawal_total: "finance.read",
  risk_level: "risk.read",
};
export function maskValue(field: string, v: unknown): unknown {
  if (v == null) return v;
  const s = String(v);
  if (field === "email") return s.replace(/^(.).*(@.*)$/, "$1***$2");
  if (field === "phone") return s.slice(0, 4) + "****" + s.slice(-2);
  if (field === "display_name") return s.split(" ").map((p) => p[0] + "***").join(" ");
  if (field === "birth_date") return s.slice(0, 4) + "-**-**";
  return "restricted";
}
export function maskRecord<T extends Record<string, unknown>>(role: string, rec: T): T & { _masked: string[] } {
  const out: Record<string, unknown> = { ...rec };
  const masked: string[] = [];
  for (const [field, perm] of Object.entries(FIELD_RULES)) {
    if (field in out && !can(role, perm)) { out[field] = maskValue(field, out[field]); masked.push(field); }
  }
  return { ...(out as T), _masked: masked };
}
