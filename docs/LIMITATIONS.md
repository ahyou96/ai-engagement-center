# Known limitations & remaining production requirements

This is a working first release designed to run locally on synthetic data. The items below are stated plainly so nobody mistakes the demo for a production system.

## Architecture
- **SQLite, single node.** Not PostgreSQL. No Redis, no message queue, no separate worker; background jobs (journey waits, approval expiry, scheduled runs, segment refresh) run in-process every 30 s. Workflow runs survive restarts (persisted per node), but there is no multi-replica coordination.
- **Rate limiting and SSE fan-out are in-memory** — correct for one process only.
- **No load testing.** Tested only at the default seed (10k profiles, 100k events). The "millions of profiles" targets in ARCHITECTURE.md are design goals, not measured capacity.

## AI
- In the default mock mode, **agents are deterministic TypeScript functions** (SQL queries + rules); the Copilot uses a keyword planner and template narration. Both are labelled "simulated AI" in the UI.
- The Anthropic / OpenAI / OpenAI-compatible code paths (streaming + tool calling) were written against the documented APIs but **were not exercised against live endpoints** in this build (no keys were configured). Treat them as untested until you run them.
- Continuous optimization = versioned configs + historical replay / holdout cohorts + a two-proportion z-test + human approval. It is **not** model retraining, and the "experiments" for KYC/provider/routing use seeded or replayed data, not live randomized traffic splits. Live randomized splits exist only for campaign A/B tests.
- No Langfuse/OpenTelemetry tracing of LLM calls.

## Integrations
- **All channels are mock.** No real SMS/WhatsApp/Viber/Messenger/Telegram/email/push adapter is included; the API refuses `mode=live`. Delivery receipts are simulated deterministically.
- BI/CRM/KYC/payment/gaming/CS/offer systems are represented by seeded tables and `data_sources` rows in mock mode; no connectors are implemented beyond the event-ingestion API and the delivery webhook.
- Outbound webhooks (and the journey "Call Webhook" action) are not delivered.
- CSV import has no upload UI.

## Security & compliance
- Local username/password auth with scrypt + httpOnly session cookies; **no SSO, no MFA**. Demo users and a demo ingestion key are seeded — remove them for any shared environment.
- Field-level masking is applied on customer list/detail, segment members and exclusions; it has not been audited across every endpoint.
- Compliance rules (age 21+, KYC, consent, exclusions, frequency caps, quiet hours) are **demo defaults and must be validated with legal** for each jurisdiction and channel before production.
- No formal prompt-injection red-team. Mitigations in place: tool outputs are treated as data, the Copilot can only produce drafts, restricted actions always need human confirmation/approval, and the deterministic policy engine gates execution.
- No encryption-at-rest for the SQLite file; no secret manager integration (env vars only).

## UI
- Simplified Chinese covers navigation, shell, common actions and page titles; most page body text is English.
- Journey Builder: the generic "Branch" node has no rule editor (use Condition nodes). Large journeys auto-fit and may render small until zoomed.
- No automated browser (Playwright) end-to-end suite; UI was verified manually in a browser (see TEST_REPORT.md).
- The mock clock "fast-forward" shifts the platform clock globally (demo only; audited).

## Data
- All data is synthetic and generated deterministically (`AEC_SEED`). Funnel and cohort shapes are plausible but not calibrated to any real operator.
