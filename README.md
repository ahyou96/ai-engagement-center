# AI Engagement Center

A self-hostable, **self-optimizing AI customer engagement platform** for a large online gaming operator:
data collection → customer intelligence → opportunity discovery → multi-agent analysis → decisions →
segmentation → entitlement eligibility → campaigns & journeys → **mandatory compliance** → approval →
execution → analytics → strategy optimization → **next execution uses the latest approved strategy**.

> **Everything runs in mock mode by default.** All customer data is synthetic. No real messages are sent,
> no real entitlements are issued, no production data is accessed and no paid AI calls are made unless you
> explicitly configure a provider (see [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)).

## Quick start (local)

Requirements: Node.js ≥ 20 (tested on 24.x), npm. No database server needed (SQLite file).

```bash
npm install
```

```bash
npm run seed        # ~40 s: 10,000 customers, 100,000 events, 20 providers, 200 games … → data/aec.db
```

```bash
npm run dev         # http://localhost:3210
```

Optional: `cp .env.example .env.local` to change seed size, AI provider, etc. Larger datasets:
`AEC_SEED_CUSTOMERS=100000 AEC_SEED_EVENTS=1000000 npm run seed`.

### Docker

```bash
docker compose up --build    # http://localhost:3210 (seeds on first start into the aec-data volume)
```

## Demo accounts (local only)

All passwords: `demo1234`. The login page has one-click buttons. **Change or remove these before any shared deployment.**

| Account | Role | Notes |
|---|---|---|
| admin@aec.local | Administrator | everything incl. settings & emergency stop |
| ops@aec.local | Operations Manager | runs workflows, **approves** |
| compliance@aec.local | Compliance Officer | policies, **approves**, restricted RG/transaction data |
| crm@aec.local | CRM Specialist | builds segments/campaigns/journeys; cannot approve |
| analyst@aec.local | Data Analyst | read-only, **PII masked** |
| cs@aec.local | Customer Service | Customer 360 with PII |
| finance@aec.local | Finance | budgets, restricted financial data |

Separation of duties is enforced: the requester of an approval can never approve it; high-risk approvals need two different approvers.

Demo event-ingestion API key (local mock only): `aec_demo_ingest_key_local_only` → `POST /api/events` with header `x-api-key`.

## The 12 modules

| Module | What works |
|---|---|
| AI Copilot | Real token streaming (SSE over POST), observable tool calls with sources, tables/charts, drafts that require confirmation, cancel/regenerate, history, export. Mock planner by default; Anthropic / OpenAI / OpenAI-compatible (DeepSeek, Ollama, Gemini) with tool calling when configured. |
| Overview | 40+ KPIs computed live from shared tables, each with definition + formula; filters (date, platform, provider, channel, segment, campaign); drill-down; AI insights; live refresh over SSE; CSV export. |
| Opportunity Finder | 14-agent workflow canvas (React Flow) streaming live; node drawers with structured I/O, evidence, tool logs, tokens/cost, confidence; manual & policy-gated automatic modes; run/schedule/pause/resume/stop/emergency stop/retry/inject failure/simulation/historical replay/compare runs; restart recovery. |
| Audience | Customer 360 (16 dimensions, field-level masking), gaming intelligence, identity resolution (verified-only auto-link, review queue), tags, visual nested segment builder, AI segment builder, event explorer & dictionary, segment analytics. |
| Personalized Offers | Deterministic No/Reduced/Standard/Enhanced engine, explainable decisions, interactive simulator, budgets with atomic reservation + reconciliation, idempotent issuance, lifecycle, analytics. |
| Campaign | 5-step wizard, objective classification by purpose, consent/frequency/quiet-hours/budget validation, A/B tests, approval, mock execution with consented channel fallback, reports, versions. |
| Journey Builder | Drag-and-drop React Flow builder, all trigger/condition/action/flow node types, validation (cycles, missing config), undo/redo, simulation, publish (approval for promotional), version pinning, per-node counts, exit rules, per-user stop, mock clock fast-forward. |
| Omni Channel | 10 channels behind one adapter interface (all mock, clearly labelled), templates with AI-assisted drafting + compliance validation + approval, delivery tracking, HMAC-signed delivery webhooks. |
| Analytics | 15 analytics modules incl. gaming experience funnel, cohorts, attribution (with correlation caveat), costs, AI performance, strategy & compliance analytics. |
| AI Strategy Optimizer | Strategy Registry with versions/statuses, historical replay + two-proportion z-test, approval, activation, rollback, optimizer settings. |
| Compliance | Mandatory enforcement layer, policies (age 21+ demo default, consent, exclusions, caps, quiet hours…), Approval Center (multi-level), append-only hash-chained Audit Center, validator, emergency stop. |
| Settings | Org, users, roles × permissions, AI providers (server-side credentials only), agents, data sources, API keys, webhooks, field mapping, scheduler, flags, system health. |

## Demonstration walkthrough

See **[docs/DEMO.md](docs/DEMO.md)** for step-by-step Scenarios A–E (provider failure, KYC assistance,
membership entitlements, channel delivery failure, responsible gaming protection), including how to show that
**the next execution uses the newly approved strategy version** and how to roll back.

## Tests

```bash
npm test          # vitest: 52 tests (engines, workflows, compliance, streaming, metrics)
npm run typecheck
```

Latest results: [docs/TEST_REPORT.md](docs/TEST_REPORT.md).

## Documentation

- [Architecture & technology decisions](docs/ARCHITECTURE.md)
- [API reference](docs/API.md)
- [Data dictionary & metric definitions](docs/DATA_DICTIONARY.md)
- [Integrations (enabling real providers)](docs/INTEGRATIONS.md)
- [Dependencies & licenses](docs/DEPENDENCIES.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Known limitations & production requirements](docs/LIMITATIONS.md)
