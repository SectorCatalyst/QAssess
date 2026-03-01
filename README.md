# QAssess

QAssess is an assessment platform with:
- Admin Studio (build landing pages, questions, scoring, reports, integrations)
- Public Runner (client-facing assessment flow)
- PDF export queue worker
- Webhook delivery worker

## Local URLs

- Admin Studio: `http://127.0.0.1:4173`
- Client runner: `http://127.0.0.1:4173/run/<your-published-slug>`
- API health check: `http://127.0.0.1:4000/healthz`

## Local Start (quick)

1. Start API:
   - `cd apps/api`
   - `cp .env.example .env`
   - `npm install`
   - `npm run db:migrate`
   - `psql "$DATABASE_URL" -f db/seeds/0001_dev_seed.sql`
   - `npm run dev`
2. Start Web:
   - `cd apps/web`
   - `npm install`
   - `npm run dev`
3. Login to Studio at `http://127.0.0.1:4173`:
   - Email: `owner@acme.example`
   - Password: `ChangeMe123!`
   - Tenant slug: `acme`

## Deploy On Render (one-click blueprint)

This repo includes `/render.yaml` for Render Blueprint deploy.

1. In Render, click `New` -> `Blueprint`.
2. Select repo: `SectorCatalyst/QAssess`.
3. Render will detect `render.yaml` and show:
   - `qassess-api` (web service)
   - `qassess-web` (static frontend)
   - `qassess-pdf-worker` (worker)
   - `qassess-webhook-worker` (worker)
   - `qassess-db` (Postgres)
4. Set these secret values in env group `qassess-shared-secrets`:
   - `JWT_ACCESS_SECRET`
   - `JWT_REFRESH_SECRET`
   - `WEBHOOK_SECRET_ENCRYPTION_KEY`
5. Deploy blueprint.
6. Open service `qassess-web` URL in Render to use the app.

Notes:
- API migrations run automatically before each API deploy (`preDeployCommand`).
- Frontend API URL is wired automatically from `qassess-api` service URL.
