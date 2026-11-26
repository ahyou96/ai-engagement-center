# Deployment

## Local
```bash
npm install && npm run seed && npm run dev      # http://localhost:3210
```
Production mode locally: `npm run build && npm start`.

## Docker
```bash
docker compose up --build
```
The container seeds `/data/aec.db` (named volume `aec-data`) on first start. `AEC_INSECURE_COOKIE=1` is set in compose because local
Docker serves plain HTTP; **remove it behind TLS**.

## Before any shared / production deployment (required)
1. Replace demo users and the demo ingestion API key; set a strong `AEC_SESSION_SECRET`; terminate TLS.
2. Move to PostgreSQL (driver swap + migration port) and a durable queue/worker tier; run more than one replica only after
   moving rate limiting and SSE fan-out to Redis (in-process state today).
3. Configure SSO (OIDC/Keycloak), backup schedule and retention (`settings.organization.data_retention_days`, `audit_retention_days`).
4. Validate age, consent, quiet-hours and channel rules with legal for each jurisdiction (age default 21+ is a demo value).
5. Load-test and document measured capacity (none has been measured yet).

## CI/CD preparation
Suggested pipeline: `npm ci` → `npm run typecheck` → `npm test` → `npm run build` → docker build/push. No pipeline file is committed
because the target CI system is not known.

## Public demo deployment (`AEC_PUBLIC=1`)
Public mode hardens the demo: no `demo1234` password (uses the `AEC_DEMO_PASSWORD` secret, ≥12 chars, or prints a random one once
in the seed log), no demo ingestion API key, no one-click logins, per-IP login rate limit, HSTS + frame/sniff/referrer headers.
Data is still synthetic and everything stays in mock mode (no real messages, no paid AI calls).

- **Render:** push this folder to a Git repo, then Render → New → Blueprint (uses `render.yaml`), set `AEC_DEMO_PASSWORD`.
  Free plan = no disk, so data is re-seeded on each restart.
- **Fly.io:** `fly launch --copy-config --no-deploy` → `fly volumes create data --size 1` (optional persistence) → `fly secrets set AEC_DEMO_PASSWORD=…` → `fly deploy`.
