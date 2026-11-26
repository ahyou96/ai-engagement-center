# Test execution report

Run on 2026-11-26, macOS arm64, Node 24.21.0. Commands: `npm run typecheck`, `npm test`, `next build`.

| Check | Result |
|---|---|
| TypeScript (`tsc --noEmit`, strict) | ✅ no errors |
| Unit + integration tests (vitest, 3 files) | ✅ **52 / 52 passed** (~17 s) |
| Production build (`next build`) | ✅ compiled, 18 routes |
| End-to-end over HTTP against the running dev server | ✅ see below |
| Manual browser verification | ✅ see below |

Each test file seeds its own temporary database (1,500–2,500 synthetic customers) so tests are isolated and deterministic.

## Automated tests

```
 ✓ tests/workflow.test.ts > Scenario A — provider failure (manual mode) > detects the incident and pauses at the approval gateway
 ✓ tests/workflow.test.ts > Scenario A — provider failure (manual mode) > cannot be approved by the requesting agent's own identity; approval resumes execution
 ✓ tests/workflow.test.ts > Scenario A — provider failure (manual mode) > optimizer generated a candidate; after approval the NEXT run uses the new version; rollback restores
 ✓ tests/workflow.test.ts > Scenario B — KYC (automatic mode, low-risk actions auto-execute) > publishes the service journey without human approval and exits verified players
 ✓ tests/workflow.test.ts > Scenario C — entitlements require approval; Scenario D — channel recovery > C waits for approval (issue_entitlement is never auto-executed)
 ✓ tests/workflow.test.ts > Scenario C — entitlements require approval; Scenario D — channel recovery > D detects degraded SMS and resends via consented fallbacks
 ✓ tests/workflow.test.ts > Scenario E via workflow > verifies protection end-to-end and does not optimize engagement
 ✓ tests/workflow.test.ts > workflow controls > retries a failed node after an injected failure
 ✓ tests/workflow.test.ts > workflow controls > recovers runs left 'running' after a restart
 ✓ tests/workflow.test.ts > workflow controls > pause / resume
 ✓ tests/workflow.test.ts > workflow controls > emergency stop halts runs, pauses journeys and blocks non-simulation starts
 ✓ tests/workflow.test.ts > campaigns & journeys > campaign: validate → submit → approve (separation of duties) → execute (mock)
 ✓ tests/workflow.test.ts > campaigns & journeys > journey validation detects cycles and missing config
 ✓ tests/workflow.test.ts > campaigns & journeys > journey simulation counts per node without side effects
 ✓ tests/workflow.test.ts > campaigns & journeys > promotional journeys require approval to publish
 ✓ tests/analytics.test.ts > dashboard metric consistency > overview metrics equal direct queries on shared tables
 ✓ tests/analytics.test.ts > dashboard metric consistency > filters change query results (platform)
 ✓ tests/analytics.test.ts > dashboard metric consistency > ingested gaming events are reflected in launch metrics
 ✓ tests/analytics.test.ts > dashboard metric consistency > attribution is labelled as correlation
 ✓ tests/analytics.test.ts > AI segment builder & copilot streaming > parses the reference natural-language segment
 ✓ tests/analytics.test.ts > AI segment builder & copilot streaming > refuses vulnerability/loss-based targeting
 ✓ tests/analytics.test.ts > AI segment builder & copilot streaming > streams tool events, text tokens and structured parts in order, then persists
 ✓ tests/analytics.test.ts > AI segment builder & copilot streaming > supports cancellation
 ✓ tests/core.test.ts > authentication & permissions > hashes and verifies passwords (scrypt)
 ✓ tests/core.test.ts > authentication & permissions > seeds demo users with roles
 ✓ tests/core.test.ts > authentication & permissions > enforces role permissions
 ✓ tests/core.test.ts > authentication & permissions > masks PII and financial fields by role
 ✓ tests/core.test.ts > event ingestion > validates, rejects unknown events and players
 ✓ tests/core.test.ts > event ingestion > deduplicates by event_id
 ✓ tests/core.test.ts > event ingestion > gaming events update the customer profile
 ✓ tests/core.test.ts > event ingestion > requires dictionary attributes
 ✓ tests/core.test.ts > dynamic segmentation > compiles nested AND/OR with parameters only (no injected SQL)
 ✓ tests/core.test.ts > dynamic segmentation > adds and removes members automatically when events change
 ✓ tests/core.test.ts > dynamic segmentation > promotional segments always exclude self-excluded / RG-restricted players
 ✓ tests/core.test.ts > dynamic segmentation > supports segment set operations (difference)
 ✓ tests/core.test.ts > compliance > blocks self-excluded players from marketing but allows protective contact
 ✓ tests/core.test.ts > compliance > requires channel consent
 ✓ tests/core.test.ts > compliance > enforces age eligibility (21+ demo default) for promotions
 ✓ tests/core.test.ts > compliance > mandatory policies cannot be disabled
 ✓ tests/core.test.ts > compliance > content validation rejects loss-chasing language and missing RG notice
 ✓ tests/core.test.ts > messaging > is idempotent and enforces compliance on every send
 ✓ tests/core.test.ts > messaging > rejects unapproved templates and purpose mismatch
 ✓ tests/core.test.ts > offers & budgets > produces explainable, deterministic decisions
 ✓ tests/core.test.ts > offers & budgets > never uses deposits/losses: changing financial data does not change decisions
 ✓ tests/core.test.ts > offers & budgets > gives excluded players no offer
 ✓ tests/core.test.ts > offers & budgets > prevents duplicate issuance (idempotent batch + per-user limit)
 ✓ tests/core.test.ts > offers & budgets > never exceeds budget (atomic reservation) and reconciles
 ✓ tests/core.test.ts > offers & budgets > simulation persists decisions but issues nothing
 ✓ tests/core.test.ts > identity resolution > links verified identities and queues uncertain ones for review
 ✓ tests/core.test.ts > responsible gaming protection (Scenario E) > excludes the player everywhere and stops pending promotional activity
 ✓ tests/core.test.ts > audit & streaming > audit log is append-only and hash-chained
 ✓ tests/core.test.ts > audit & streaming > stream events are ordered and replayable after a given id
```

Coverage vs the brief's required areas: authentication ✓, permissions/masking ✓, customer profile ✓ (via metrics + protection tests), identity resolution ✓,
gaming event ingestion ✓, deduplication ✓, segment entry/exit ✓, rule evaluation ✓, offer eligibility ✓, budget limits ✓, duplicate issuance ✓,
campaign creation→approval→execution ✓, journey creation/validation/simulation/execution & exit ✓, AI streaming (copilot parts order + cancel) ✓,
workflow state recovery ✓, manual approval ✓, automatic rule validation ✓, compliance blocking ✓, channel consent ✓, strategy activation ✓,
next execution uses latest approved strategy ✓, rollback ✓, emergency stop ✓, dashboard metric consistency ✓.

Not covered by automated tests: UI components (no Playwright suite), real AI provider calls, load/performance.

## End-to-end over HTTP (dev server, full 10k seed)

Script: log in → start *Gaming Provider Failure* (manual) → approve the decision → wait → approve the optimizer's strategy candidate → start a new run → roll back.

```
run1: waiting_approval strategy v4
approve decision: approved
run1 final: completed | Investigation ticket opened; 649 service notices sent (mock), 0 blocked by compliance
optimizer: Candidate improves the metric by 18.4 pts (p=0.0000) → sent for approval
approve strategy: approved
run2: completed, pinned to the new version | run1 still v4
rollback: restored previous version
audit chain: {"ok":true}
```

## Manual browser verification (desktop 1440×900, mobile 375×812, light/dark, EN/中文)

Overview (KPIs, insights, charts, live SSE), Opportunity Finder (live multi-agent canvas, approval gateway, node drawer, execution log),
Audience overview + segment builder + Customer 360, Offers decision simulator (ran a 3,000-player simulation), Campaign wizard,
Journey Builder (KYC journey), Omni Channel, Analytics (gaming funnel), Strategy Optimizer, Compliance Approval Center (mobile, light, 中文),
Copilot (streamed tool calls, segment draft, verified sample table, follow-ups).

Issues found and fixed during verification: workflow node ordering across skipped nodes; journey simulation queue bug; charts not painting in
background tabs (now synchronous paint, no animation); SSE topic streams replaying full history on connect; mobile header overflow; chart legend
theming; seed funnel realism.
