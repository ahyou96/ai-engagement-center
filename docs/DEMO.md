# Demonstration guide

Start: `npm run seed && npm run dev`, open http://localhost:3210, sign in as **admin@aec.local** (or click it on the login page).
Approvals require a *different* user than the requester — use a second browser profile signed in as **ops@aec.local** or
**compliance@aec.local** when a request was made by you. Agent-originated requests (`agent:decision`, `agent:optimizer`) can be
approved by admin.

## Scenario A — Gaming provider failure
1. **Overview** → AI insights shows "Nebula Play: …% launch failures (24h)" (synthetic incident in the last 6 h).
2. **Opportunity Finder → Run now** → *Gaming Provider Failure Response*, Manual mode. Watch the canvas stream: Data Intelligence → Discovery (opportunity created) → Gaming + Customer Intelligence in parallel → Root Cause (hypotheses with confidence) → Decision → Audience (dynamic segment) → Campaign draft → Compliance → **Approval Gateway (waiting)**. Offer & Journey nodes are skipped with reasons.
3. Click any node for its structured input/output, evidence (verified/estimate), tool log, tokens and cost.
4. **Open approval** → approve in the Approval Center. The run resumes: investigation ticket + service notices (mock) are sent only to players with service consent.
5. Analytics node records detection coverage; **Strategy Optimizer** replays launch events with a lower threshold, runs a z-test and (if significant) creates candidate **v5** → approval.
6. Approve v5 in **Compliance → Approvals** (or **AI Strategy Optimizer**). Run the workflow again (Simulation is fine): the run header shows **strategy v5**. Use **Compare runs** to see v4 vs v5 side by side. **Rollback** in the Optimizer restores v4.

## Scenario B — KYC service assistance
1. Run *KYC Service Assistance* in **Automatic** mode (ops/admin). All proposed actions are low-risk service actions on the policy allow-list → executed without human approval (the gateway shows "authorized for automatic execution").
2. The "KYC stalled" dynamic segment is created/refreshed and the *KYC Assistance* journey is published (pinned to the active kyc strategy, wait = `reminder_wait_hours`) and players are enrolled (already-enrolled players are not duplicated).
3. **Journey Builder → KYC Assistance**: see executions waiting. Use *Fast-forward 24h (mock clock)* to process waits.
4. Mark a player verified (e.g. ingest a `kyc_verified` event in **Audience → Events**): they leave the segment, their execution exits with `left_trigger_segment` and pending reminders stop.
5. The optimizer compares 48 h vs 24 h reminder cohorts (holdout data) and proposes a candidate for approval.

## Scenario C — Personalized membership entitlements
1. **Personalized Offers → Decision simulator**: choose *Monthly membership benefit* + *Verified active members*; edit tier multipliers and see No/Reduced/Standard/Enhanced distribution and per-player reasons. Deposits/losses are never inputs.
2. Run *Personalized Membership Entitlements* (auto mode still stops: entitlement issuance is never auto-approved). Approve → idempotent issuance with atomic budget reservation; claims/redemptions are simulated.
3. **Offers → Analytics / Budgets / Transactions**: lifecycle, fairness by tier, duplicates prevented, reconciliation.
4. Optimizer proposes a lower Enhanced multiplier so more members are served at their intended tier within budget.

## Scenario D — Channel delivery failure
1. **Omni Channel**: SMS is *degraded* (~74 % delivery in 24 h vs ~96 % before; mock receipts).
2. Run *Channel Delivery Recovery* → affected players identified → fallback via consented channels only (inbox/viber…) → delivery & cost comparison → optimizer proposes a routing change.

## Scenario E — Responsible gaming protection
1. Run *Responsible Gaming Protection* (or ingest `self_exclusion_enabled` for any player in **Audience → Events**).
2. Immediately and synchronously: profile flags, exclusion record, `rg_excluded` compliance tag, removal from promotional segments, promotional journeys stopped, queued promotional messages and unclaimed entitlements cancelled, protective service task created — all in one audited `compliance.protection_applied` record.
3. The workflow verifies: marketing **blocked**, incentives **blocked**, protective contact **allowed**; optimizer explicitly does not optimize engagement.

## Other things to try
- **Copilot**: "Find users who experienced game loading failures in the last seven days and have unresolved customer service tickets." → structured rules, preview, confirm to save. Try "players who lost the most money" → refused by policy.
- **Emergency stop** (top bar): stops runs, pauses journeys/campaigns; only simulations can start.
- Switch **language** (中/EN) and **theme**; press **⌘K** for the command palette, **⌘J** for Copilot.
- Sign in as **analyst@aec.local** to see PII masking and disabled write actions.
