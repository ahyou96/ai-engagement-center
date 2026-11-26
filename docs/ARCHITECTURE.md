# Architecture

## First-release shape (what actually runs)

```
Browser (Next.js App Router, React 19, Tailwind v4, ECharts, React Flow)
   │  fetch /api/*  (JSON)          EventSource /api/stream, /api/workflows/runs/:id/stream (SSE)
   ▼                                POST /api/copilot/chat (SSE over a streamed POST response)
Next.js route handler  src/app/api/[...path]/route.ts  →  src/lib/router.ts (single documented router)
   │   auth (session cookie, scrypt), RBAC, CSRF origin check, rate limit, zod validation
   ▼
Domain services (src/lib)                                  Background (src/lib/scheduler.ts, in-process)
 ├─ compliance.ts   mandatory policy engine ◄── every send / every issuance calls it
 ├─ messaging.ts    unified channel adapter interface (mock adapter; live adapters gated)
 ├─ offers.ts       deterministic entitlement engine, atomic budgets, idempotent issuance
 ├─ segments.ts     rule DSL → parameterised SQL, incremental per-player evaluation
 ├─ journeys.ts     journey validation, execution, waits, exits, simulation
 ├─ campaigns.ts    wizard backend, preflight validation, A/B, mock execution
 ├─ cdp.ts          event ingestion (validate→dedupe→profile→segments→journeys), identity, RG protection
 ├─ strategy.ts     Strategy Registry, z-test evaluation, approval, activation, rollback
 ├─ approvals.ts    multi-level approvals with separation of duties
 ├─ workflow/       14 logical agents + DAG engine (persisted, resumable)
 ├─ ai/             provider abstraction (mock / Anthropic / OpenAI / OpenAI-compatible) + Copilot tools
 ├─ metrics.ts      Overview/analytics metrics with definitions & formulas
 ├─ audit.ts        append-only, hash-chained audit log
 └─ stream.ts       durable event stream (stream_events.seq = SSE id) + in-process fan-out
   ▼
SQLite (better-sqlite3, WAL) — migrations/001_init.sql — 60+ tables
```

Every module reads and writes the **same tables**: e.g. an ingested `game_launch_failed` event updates the
customer profile aggregates, re-evaluates realtime segments for that player, may enrol them in a journey,
shows up in Overview metrics and in the Provider Failure workflow's detection replay.

## Key design decisions

| Decision | Choice | Why / trade-off |
|---|---|---|
| Runtime | Next.js 16 (App Router) full-stack, Node runtime | One deployable, typed end-to-end. A dedicated backend can be split out later behind the same `/api` contract. |
| Database | **SQLite (WAL)** instead of PostgreSQL | Docker was not running in the build environment and the brief demands a runnable local system. Schema uses portable SQL (TEXT ids, ISO timestamps, JSON text columns, FKs, unique/idempotency keys, indexes). Moving to PostgreSQL requires a driver swap in `db.ts` + JSON→JSONB / AUTOINCREMENT→IDENTITY migration — **not done**. |
| Queue / Redis | None in v1 | Background work runs in-process (`scheduler.ts`); workflow state is persisted after every node so restarts resume (`recoverRuns`). Production: Redis/BullMQ or Temporal workers. |
| Real-time | SSE | `stream_events` table gives ordered ids, replay via `Last-Event-ID`, de-duplication by seq; mock and real integrations publish through the same `publish()` interface. |
| Agents | Deterministic TypeScript agents with structured JSON I/O | Reproducible, testable, explainable; an LLM is optional for narrative only (`narrate()`), never for policy. LangGraph/Dify were evaluated but not needed for a deterministic DAG. |
| Policy | Deterministic policy engine (`policyEvaluate`, `compliance.evaluate`) | AI output is an untrusted proposal; only allow-listed low-risk actions auto-execute; everything else needs human approval. OPA is the production candidate (same inputs/outputs). |
| Segments | JSON rule DSL compiled to parameterised SQL over a field whitelist | Injection-safe; same compiler powers builder, AI builder, journey conditions, estimates. |
| Offers | Deterministic engine; inputs restricted by code | Losses/deposits/wagering/vulnerability are never read — enforced and unit-tested. |
| Strategy optimization | Versioned configs + historical replay + two-proportion z-test + approval | Honest: this is **not** model retraining. Minimum sample, minimum improvement, confidence and max deterioration are configurable. |
| Audit | Append-only (DB triggers block UPDATE/DELETE) + SHA-256 hash chain | Tamper evidence; `GET /api/audit/verify`. |
| Auth | Local users, scrypt, httpOnly SameSite cookie sessions, RBAC + field masking | Keycloak/SSO is the production path (OIDC) — not implemented. |

## Workflow engine

`workflow/definitions.ts` declares 5 workflows over the same 15-node graph (14 agents + approval gateway).
Nodes that do not apply to a scenario are statically **skipped with a reason**; a skipped node counts as done
only once its own upstream is done (keeps ordering). Agents may `halt` (e.g. "no anomaly") or `awaitApproval`.

- Each run **pins** the latest approved+active strategy version (`getActiveStrategy`) in `ai_workflow_runs.strategy_version`; existing runs never change version.
- Every node execution, tool call and event is persisted (`ai_node_executions`, `ai_tool_calls`, `stream_events`).
- Retries: transient failures auto-retry (3 attempts with backoff); injected demo failures stop for manual retry.
- Recovery: on boot, runs in `running` resume from the last persisted node; actions are idempotent (message/offer idempotency keys) so re-execution is safe.
- Emergency stop: stops runs, pauses journeys & approved campaigns, blocks non-protective sends in the compliance layer.

## Scalability (targets vs tested)

Tested in this build: 10k profiles / 100k events seed (≈40 s), Overview computed in ~100–300 ms locally, test suite 52 tests.
**No load testing was performed.** Architectural targets for millions of profiles require: PostgreSQL (partitioned events) or
ClickHouse for events, Kafka/Redpanda ingestion, incremental segment materialisation, a worker tier with a durable queue, horizontal
API replicas with Redis-backed rate limiting and SSE fan-out. See [LIMITATIONS.md](LIMITATIONS.md).

## Open-source projects evaluated

Assessment is based on the team's knowledge of these projects (not re-verified online during this build — re-check licenses and
maintenance before adoption).

| Project | Role considered | Decision for v1 | Notes |
|---|---|---|---|
| Apache Unomi / Tracardi | CDP | Not used | Heavy (ES/Karaf) or smaller community; our CDP needs are covered by relational tables + rule compiler. Tracardi license should be checked for commercial use. |
| RudderStack | Event collection | Adapter target | Good for SDK-side collection → forward to `POST /api/events`. |
| PostHog | Product analytics | Not used | Overlaps; self-host footprint large. |
| ClickHouse | Event analytics | Production candidate | For >100M events; metrics module isolates queries. |
| Kafka / Flink | Streaming | Production candidate | The monorepo already runs Flink (`dos-flink`); ingest API can be fed from a Kafka consumer. |
| Feast | Feature store | Not needed | No ML models in v1. |
| Mautic / Novu / Chatwoot | Messaging | Novu = adapter candidate | Our `ChannelAdapter` interface maps cleanly onto Novu workflows. |
| Activepieces / Temporal | Orchestration | Temporal = production candidate | Engine semantics (persisted steps, retries, signals for approval) map 1:1 to Temporal workflows. |
| GrowthBook / MLflow / Optuna | Experimentation | GrowthBook = candidate | v1 uses its own z-test; GrowthBook could own allocation + stats. |
| Open Policy Agent | Policy | Production candidate | `compliance.evaluate` inputs/outputs are OPA-shaped. |
| Keycloak | Auth | Production candidate | Replace local sessions with OIDC. |
| Vercel AI SDK / LangGraph / Dify / Langfuse | AI layer | Not used (direct fetch) | Avoided extra deps; provider layer is ~150 lines. Langfuse tracing could wrap `streamLLM`. |
