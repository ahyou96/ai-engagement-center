# Integrations

All external integrations are **disabled / mocked by default**. Nothing in the UI can enable live sending; it requires server-side
configuration plus code for a verified adapter.

## AI providers
Credentials live only in server environment variables (never in the DB or browser). Settings → AI models shows whether each is configured.

| Provider | Env | Notes |
|---|---|---|
| Mock (default) | `AEC_AI_PROVIDER=mock` | Deterministic planner + tools; labelled "simulated AI" in the UI. |
| Anthropic | `AEC_AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`) | Messages API with streaming + tool use. |
| OpenAI | `AEC_AI_PROVIDER=openai`, `OPENAI_API_KEY`, `OPENAI_MODEL` | Chat Completions streaming + tool calls. |
| OpenAI-compatible (DeepSeek, Ollama, Gemini) | `AEC_AI_PROVIDER=openai_compatible`, `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_MODEL` | e.g. Ollama `http://localhost:11434/v1`. |

The Copilot sends tool results (aggregated platform data, masked per the user's role) to the configured provider. Review data-processing
agreements before enabling a hosted provider. Workflow agents only use the LLM for narrative text (`narrate()`); policy decisions never depend on it.

## Messaging channels
`src/lib/messaging.ts` defines `ChannelAdapter.send()`. Only the mock adapter is shipped. To enable a real provider:
1. Implement an adapter (e.g. Twilio/Infobip SMS, WhatsApp Cloud API, Viber Business, FCM/APNs, SES) returning `{status, providerRef, errorCode}`.
2. Store credentials in a secret manager → env; register the adapter in `adapterFor()`.
3. Verify the connection and set `channels.mode='live'`, `connection_status='verified'` via a migration/ops script (the API refuses `mode=live`).
4. Set `AEC_ALLOW_REAL_SENDING=true`. Delivery receipts → `POST /api/webhooks/delivery` signed with `x-aec-signature` (HMAC-SHA256, `AEC_WEBHOOK_SECRET`).
5. Complete provider-specific requirements (WhatsApp template approval, SMS sender-ID registration, opt-out keywords) and legal review.

## Data sources (BI, CRM, KYC, payment, gaming, customer service, offers)
Seeded as `data_sources` rows in `connected_mock` mode. Integration paths:
- **Events / gaming:** push to `POST /api/events` (API key with `events.ingest`), or a Kafka/Flink consumer that calls `ingestEvents()`; RudderStack can forward here.
- **CRM / KYC / CS:** batch upserts into `customers`, `customer_identities`, `service_tickets` (CSV/DB ETL); KYC changes should arrive as `kyc_*` events so segments and journeys react.
- **Payment / betting (restricted):** load into `gaming_transactions` only for accounting/fraud/compliance/RG roles; never used by offers or segments for engagement.
- **Offer / promotion system:** replace `issueOne()` persistence with a call to the real wallet/promotion API, keeping the idempotency key and budget reservation.

## Webhooks (outbound)
`webhooks` table + Settings UI list targets; outbound delivery is not implemented (journey `call_webhook` is mocked).
