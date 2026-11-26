# API reference

Base path `/api`. JSON in/out unless noted. Authentication: session cookie from `POST /api/auth/login`
(httpOnly, SameSite=Lax). `POST /api/events` additionally accepts `x-api-key` (scope `events.ingest`).
Mutating cookie-authenticated requests must be same-origin (CSRF check). Errors: `{ "error": string, "details"?: any }`
with 400 (validation, zod details), 401, 403 (permission / separation of duties), 404, 409 (state conflict),
422 (business validation, `details` = issues), 423 (emergency stop), 429 (rate limit).

## Streaming

| Endpoint | Transport | Notes |
|---|---|---|
| `GET /api/stream?topics=a,b` | SSE | Topics: `workflow, approvals, strategies, segments, journeys, delivery, events, offers, campaigns, compliance, notifications, system`. Starts live; reconnect with `Last-Event-ID` (or `?after=<seq>`) to replay missed events in order. |
| `GET /api/workflows/runs/:id/stream` | SSE | Full replay of one run's events (`run.*`, `node.*`, `tool.*`), then live. |
| `POST /api/copilot/chat` `{message, conversation_id?}` | SSE in response body | Parts: `meta, tool_start, tool_end, text, table, chart, draft, notice, suggestions, error, done`. Abort the request to cancel. |

## Examples

```bash
# ingest gaming events (dedup by event_id; validated against the event dictionary)
curl -X POST localhost:3210/api/events -H 'x-api-key: aec_demo_ingest_key_local_only' -H 'content-type: application/json' \
  -d '[{"event_id":"evt-1","event_name":"game_launch_failed","player_id":"P100010","game_id":"gm_003","provider_id":"prv_03","error_code":"PROVIDER_TIMEOUT","loading_duration":21000}]'

# provider delivery receipt (HMAC-SHA256 of the raw body with AEC_WEBHOOK_SECRET, hex)
BODY='{"message_id":"msg_x","status":"delivered"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac dev-webhook-secret -hex | cut -d' ' -f2)
curl -X POST localhost:3210/api/webhooks/delivery -H "x-aec-signature: $SIG" -H 'content-type: application/json' -d "$BODY"
```

Key request bodies (all zod-validated server-side; see `src/lib/router.ts`):

- `POST /api/workflows/run` `{scenario: provider_failure|kyc_assistance|membership_entitlements|channel_delivery|rg_protection, mode: manual|auto, simulation, inject_failure?, schedule_minutes?}`
- `POST /api/workflows/runs/:id/control` `{action: pause|resume|stop|retry|replay, node?}`
- `POST /api/approvals/:id` `{action: approve|reject|request_changes, comment?}`
- `POST /api/segments` `{name, type: static|dynamic|realtime, purpose, rules}` — rules DSL: `group{op,negate,children} | attr{field,op,value} | event{event,op,count,within_days,provider_id?} | tag{tag,has} | segment{segment_id,in} | attr_change{field,to,within_days}`
- `POST /api/offers/:id/simulate` `{segment_id | player_ids, config?}` · `POST /api/offers/:id/batch` `{segment_id, simulate}`
- `POST /api/campaigns` · `POST /api/campaigns/:id/action` `{action: validate|simulate|submit|execute|pause|cancel|duplicate}`
- `PUT /api/journeys/:id` `{definition}` · `POST /api/journeys/:id/action` `{action: validate|simulate|publish|pause|resume|stop|tick|fast_forward|enroll_segment, hours?}`
- `POST /api/strategies/:id/action` `{action: activate|rollback|pause|archive|submit|candidate, version?, config?}`
- `POST /api/compliance/validate` `{segment_id | player_ids, purpose, channel?, action, body?}`

## All routes

Generated from the router (`npx tsx scripts/gen-api-docs.ts`).

<!-- ROUTES:START -->
| Method | Path | Permission |
|---|---|---|
| `POST` | `/api/auth/login` | public |
| `POST` | `/api/auth/logout` | authenticated |
| `GET` | `/api/auth/me` | authenticated |
| `GET` | `/api/health` | public |
| `GET` | `/api/stream` | dashboard.read |
| `GET` | `/api/notifications` | dashboard.read |
| `POST` | `/api/notifications/read` | dashboard.read |
| `GET` | `/api/overview` | dashboard.read |
| `GET` | `/api/filters` | dashboard.read |
| `GET` | `/api/search` | dashboard.read |
| `POST` | `/api/copilot/chat` | copilot.use |
| `GET` | `/api/copilot/conversations` | copilot.use |
| `GET` | `/api/copilot/conversations/:id` | copilot.use |
| `DELETE` | `/api/copilot/conversations/:id` | copilot.use |
| `GET` | `/api/opportunities` | opportunities.read |
| `POST` | `/api/opportunities/:id` | workflows.control |
| `GET` | `/api/workflows` | opportunities.read |
| `POST` | `/api/workflows/run` | workflows.run |
| `GET` | `/api/workflows/runs/:id` | opportunities.read |
| `GET` | `/api/workflows/runs/:id/stream` | opportunities.read |
| `POST` | `/api/workflows/runs/:id/control` | workflows.control |
| `POST` | `/api/workflows/decisions/:id` | approvals.decide |
| `GET` | `/api/workflows/compare` | opportunities.read |
| `POST` | `/api/system/emergency-stop` | workflows.emergency_stop |
| `GET` | `/api/customers` | audience.read |
| `GET` | `/api/customers/:id` | audience.read |
| `POST` | `/api/customers/:id/tags` | tags.write |
| `POST` | `/api/customers/:id/protect` | compliance.write |
| `POST` | `/api/customers/:id/identities` | identity.merge |
| `GET` | `/api/identities/candidates` | audience.read |
| `GET` | `/api/identities/resolve` | audience.read |
| `GET` | `/api/identities/stats` | audience.read |
| `POST` | `/api/identities/candidates/:id` | identity.merge |
| `GET` | `/api/audience/overview` | audience.read |
| `GET` | `/api/gaming/intelligence` | audience.read |
| `GET` | `/api/games` | audience.read |
| `POST` | `/api/events` | authenticated |
| `GET` | `/api/events` | audience.read |
| `GET` | `/api/event-definitions` | audience.read |
| `POST` | `/api/event-definitions` | settings.write |
| `GET` | `/api/tags` | audience.read |
| `POST` | `/api/tags` | tags.write |
| `GET` | `/api/segments` | audience.read |
| `GET` | `/api/segments/fields` | audience.read |
| `POST` | `/api/segments/estimate` | audience.read |
| `POST` | `/api/segments/ai` | audience.read |
| `POST` | `/api/segments` | segments.write |
| `GET` | `/api/segments/overlap` | audience.read |
| `GET` | `/api/segments/:id` | audience.read |
| `PUT` | `/api/segments/:id` | segments.write |
| `POST` | `/api/segments/:id/evaluate` | segments.write |
| `POST` | `/api/segments/:id/status` | segments.write |
| `GET` | `/api/offers` | offers.read |
| `POST` | `/api/offers` | offers.write |
| `GET` | `/api/offers/budgets` | offers.read |
| `POST` | `/api/offers/budgets` | budgets.write |
| `GET` | `/api/offers/reconcile` | offers.read |
| `GET` | `/api/offers/transactions` | offers.read |
| `POST` | `/api/offers/transactions/:id` | offers.issue |
| `GET` | `/api/offers/analytics` | offers.read |
| `GET` | `/api/offers/:id` | offers.read |
| `PUT` | `/api/offers/:id` | offers.write |
| `POST` | `/api/offers/:id/simulate` | offers.read |
| `POST` | `/api/offers/:id/batch` | offers.write |
| `GET` | `/api/offers/batches/:id` | offers.read |
| `GET` | `/api/campaigns` | campaigns.read |
| `GET` | `/api/campaigns/meta` | campaigns.read |
| `POST` | `/api/campaigns` | campaigns.write |
| `GET` | `/api/campaigns/:id` | campaigns.read |
| `PUT` | `/api/campaigns/:id` | campaigns.write |
| `POST` | `/api/campaigns/:id/action` | campaigns.read |
| `GET` | `/api/journeys` | journeys.read |
| `GET` | `/api/journeys/meta` | journeys.read |
| `POST` | `/api/journeys` | journeys.write |
| `GET` | `/api/journeys/:id` | journeys.read |
| `PUT` | `/api/journeys/:id` | journeys.write |
| `POST` | `/api/journeys/:id/action` | journeys.read |
| `POST` | `/api/journeys/executions/:id/stop` | journeys.publish |
| `GET` | `/api/channels` | channels.read |
| `PUT` | `/api/channels/:key` | channels.write |
| `POST` | `/api/channels/:key/test` | channels.write |
| `GET` | `/api/templates` | channels.read |
| `POST` | `/api/templates` | templates.write |
| `PUT` | `/api/templates/:id` | templates.write |
| `POST` | `/api/templates/:id/submit` | templates.write |
| `POST` | `/api/templates/draft` | templates.write |
| `GET` | `/api/messages` | channels.read |
| `POST` | `/api/webhooks/delivery` | public |
| `GET` | `/api/analytics/:module` | analytics.read |
| `GET` | `/api/strategies` | strategies.read |
| `GET` | `/api/strategies/:id` | strategies.read |
| `POST` | `/api/strategies/:id/action` | strategies.write |
| `PUT` | `/api/optimizer/settings` | strategies.activate |
| `GET` | `/api/compliance/policies` | compliance.read |
| `PUT` | `/api/compliance/policies/:key` | compliance.write |
| `POST` | `/api/compliance/validate` | compliance.read |
| `GET` | `/api/compliance/checks` | compliance.read |
| `GET` | `/api/compliance/exclusions` | compliance.read |
| `GET` | `/api/approvals` | dashboard.read |
| `GET` | `/api/approvals/:id` | dashboard.read |
| `POST` | `/api/approvals/:id` | approvals.decide |
| `GET` | `/api/audit` | audit.read |
| `GET` | `/api/audit/verify` | audit.read |
| `GET` | `/api/settings` | settings.read |
| `PUT` | `/api/settings/:key` | settings.write |
| `POST` | `/api/settings/flags/:key` | settings.write |
| `POST` | `/api/settings/agents/:key` | settings.write |
| `POST` | `/api/settings/api-keys` | settings.write |
| `POST` | `/api/settings/api-keys/:id/revoke` | settings.write |
| `POST` | `/api/settings/users` | settings.write |
| `PUT` | `/api/settings/users/:id` | settings.write |
| `POST` | `/api/settings/data-sources/:id/sync` | settings.write |
<!-- ROUTES:END -->
