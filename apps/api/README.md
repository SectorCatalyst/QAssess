# QAssess API Starter

This backend now includes a working `M1-M5` implementation with:

- Tenant-aware admin authentication (`/v1/auth/login`, `/v1/auth/refresh`, `/v1/users/me`)
- JWT access + refresh token rotation
- RBAC/auth middleware across admin and integration routes
- Audit log writes for login/refresh events
- Encrypted-at-rest webhook endpoint secrets (AES-256-GCM)
- Optional structured-log forwarding to centralized sink (`LOG_SINK_URL`)
- Postgres migration runner and dev seed support
- Authoring for assessments, versions, landing page builder, questions, options, and logic rules
- Public runtime/session flows: bootstrap, session start, lead capture, response upsert, completion/result scoring
- PDF job queue/status endpoints with runnable worker (`npm run worker:pdf`)
- Report template + section CRUD
- Analytics summary + dropoff read models
- Integration webhook CRUD + leads CSV export with runnable workers (`npm run worker:webhook`, `npm run worker:webhook:replay`)

Specs remain aligned to:

- `/Users/troysullivan/Documents/QAssess/specs/api/openapi.yaml`
- `/Users/troysullivan/Documents/QAssess/specs/database/postgres.sql`
- Production go-live checklist: `/Users/troysullivan/Documents/QAssess/apps/api/docs/PRODUCTION_GO_LIVE_CHECKLIST.md`
- Deployment/security runbook: `/Users/troysullivan/Documents/QAssess/apps/api/docs/DEPLOYMENT_SECURITY_RUNBOOK.md`
- Staging testing runbook: `/Users/troysullivan/Documents/QAssess/apps/api/docs/STAGING_TESTING_RUNBOOK.md`
- Migration rollback runbook: `/Users/troysullivan/Documents/QAssess/apps/api/docs/MIGRATION_ROLLBACK_RUNBOOK.md`
- Go-live plan template: `/Users/troysullivan/Documents/QAssess/apps/api/docs/GO_LIVE_PLAN_TEMPLATE.md`
- Beginner go-live walkthrough: `/Users/troysullivan/Documents/QAssess/apps/api/docs/BEGINNER_STEP_BY_STEP_GO_LIVE.md`

## Quick Start

1. Copy `.env.example` to `.env` and set secrets/DB URL.
   - For production, set `STRICT_SECRET_VALIDATION=true` and strong JWT secrets (32+ chars).
   - Set `WEBHOOK_SECRET_ENCRYPTION_KEY` (strong secret; KMS-managed in production).
   - Configure public endpoint throttles with `PUBLIC_*_RATE_LIMIT_PER_MINUTE` env vars.
2. Install dependencies from `apps/api`:
   - `npm install`
3. Apply migrations:
   - `npm run db:migrate`
4. Seed development user:
   - `psql "$DATABASE_URL" -f db/seeds/0001_dev_seed.sql`
5. Run API:
   - `npm run dev`

## Operational Commands

- Staging smoke test:
  - `npm run smoke:staging`
- Load baseline (public runtime/session):
  - `npm run load:baseline`
- Migration dry-run:
  - `npm run db:migrate:dry-run`
- Schema parity check:
  - `npm run ops:schema:parity`
- Webhook secret backfill:
  - `npm run ops:webhook-secrets:backfill -- --dry-run`
- Backup/restore drill:
  - `npm run ops:backup:restore-drill`
- Ops metrics snapshot (queue/dead-letter + threshold assertions):
  - `npm run ops:metrics:snapshot`
- Local full production rehearsal (migrate/test/build/smoke/load/workers/backup-restore):
  - `npm run ops:rehearsal:local`
- Staging execution bundle (smoke/load/parity/backfill/metrics):
  - `npm run ops:staging:execute`
- Worker orchestration templates (systemd):
  - `/Users/troysullivan/Documents/QAssess/apps/api/deploy/systemd/README.md`

## Current Implemented Routes

- `GET /healthz`
- `GET /readyz`
- `POST /v1/auth/login`
- `POST /v1/auth/refresh`
- `GET /v1/users/me`
- `GET /v1/assessments`
- `POST /v1/assessments`
- `GET /v1/assessments/:assessmentId`
- `PATCH /v1/assessments/:assessmentId`
- `GET /v1/assessments/:assessmentId/versions`
- `POST /v1/assessments/:assessmentId/versions`
- `GET /v1/versions/:versionId`
- `PATCH /v1/versions/:versionId`
- `POST /v1/versions/:versionId/publish`
- `GET /v1/versions/:versionId/landing`
- `PUT /v1/versions/:versionId/landing`
- `GET /v1/versions/:versionId/landing/blocks`
- `POST /v1/versions/:versionId/landing/blocks`
- `PATCH /v1/landing/blocks/:blockId`
- `DELETE /v1/landing/blocks/:blockId`
- `GET /v1/versions/:versionId/questions`
- `POST /v1/versions/:versionId/questions`
- `PATCH /v1/questions/:questionId`
- `DELETE /v1/questions/:questionId`
- `GET /v1/questions/:questionId/options`
- `POST /v1/questions/:questionId/options`
- `PATCH /v1/answer-options/:optionId`
- `DELETE /v1/answer-options/:optionId`
- `GET /v1/versions/:versionId/logic-rules`
- `POST /v1/versions/:versionId/logic-rules`
- `PATCH /v1/logic-rules/:ruleId`
- `DELETE /v1/logic-rules/:ruleId`
- `GET /v1/public/:slug/bootstrap`
- `POST /v1/public/:slug/sessions`
- `POST /v1/sessions/:sessionId/lead`
- `PUT /v1/sessions/:sessionId/responses`
- `POST /v1/sessions/:sessionId/complete`
- `GET /v1/sessions/:sessionId/result`
- `POST /v1/sessions/:sessionId/pdf`
- `GET /v1/pdf-jobs/:jobId`
- `GET /v1/versions/:versionId/report-template`
- `PUT /v1/versions/:versionId/report-template`
- `POST /v1/report-templates/:templateId/sections`
- `PATCH /v1/report-sections/:sectionId`
- `DELETE /v1/report-sections/:sectionId`
- `GET /v1/analytics/assessments/:assessmentId/summary`
- `GET /v1/analytics/assessments/:assessmentId/dropoff`
- `GET /v1/integrations/webhooks`
- `POST /v1/integrations/webhooks`
- `PATCH /v1/integrations/webhooks/:endpointId`
- `DELETE /v1/integrations/webhooks/:endpointId`
- `GET /v1/assessments/:assessmentId/leads/export`

## Next Build Steps

1. Enable worker/API supervision templates in staging/production (`deploy/systemd` or equivalent orchestrator).
2. Integrate real PDF rendering/storage adapters and encrypted webhook secret storage.
3. Implement analytics aggregation jobs to populate daily analytics tables automatically.
4. Wire `LOG_SINK_URL` and alerting in staging/production (ops metrics snapshots + centralized dashboards).
