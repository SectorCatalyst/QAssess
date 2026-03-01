# Staging Testing Runbook

Last updated: 2026-02-26

This runbook defines repeatable commands for staging smoke and load-baseline execution.

Beginner-friendly version:
- `/Users/troysullivan/Documents/QAssess/apps/api/docs/BEGINNER_STEP_BY_STEP_GO_LIVE.md`

## 1) Preflight

Run from `/Users/troysullivan/Documents/QAssess/apps/api`:

```bash
npm ci
npm run db:migrate
npm run check
npm test
npm run build
```

One-command staging execution bundle:

```bash
npm run ops:staging:execute
```

## 2) Staging Smoke (Functional)

Required env (example):

```bash
export API_BASE_URL="https://api.staging.example.com"
export SMOKE_TENANT_SLUG="acme"
export SMOKE_EMAIL="owner@acme.example"
export SMOKE_PASSWORD="<staging-password>"
export SMOKE_REQUIRE_PDF_COMPLETED=true
# Optional centralized logs during smoke:
# export LOG_SINK_URL="https://logs.example.com/ingest"
# export LOG_SINK_TOKEN="<token>"
```

Run:

```bash
npm run smoke:staging
```

The smoke script validates:
- auth login
- assessment authoring + publish
- public bootstrap/session/lead/response/complete flow
- PDF queue + status polling
- report template retrieval
- leads CSV export

## 3) Load Baseline (Public Runtime/Session)

Required env (example):

```bash
export API_BASE_URL="https://api.staging.example.com"
export ASSESSMENT_SLUG="public-growth"
export LOAD_TOTAL_SESSIONS=400
export LOAD_CONCURRENCY=40
export LOAD_ASSERT_THRESHOLDS=true
```

Run:

```bash
npm run load:baseline
```

Output:
- console JSON summary (success rate, RPS, p50/p95/p99 by step)
- report file in `artifacts/` unless `LOAD_REPORT_PATH` is set

## 4) Worker Operations Check

If deploying with systemd templates:
- `/Users/troysullivan/Documents/QAssess/apps/api/deploy/systemd/README.md`

Minimum checks:
- API service healthy (`/healthz`, `/readyz`)
- PDF worker timer active
- webhook worker timer active
- dead-letter replay can be triggered on demand

## 5) Data Safety Checks

Migration dry-run against staging snapshot/clone:

```bash
export MIGRATION_DRY_RUN_DATABASE_URL="<staging-clone-db-url>"
npm run db:migrate:dry-run
```

Schema migration parity (prod vs staging):

```bash
export SCHEMA_SOURCE_DATABASE_URL="<production-db-url>"
export SCHEMA_TARGET_DATABASE_URL="<staging-db-url>"
npm run ops:schema:parity
```

Webhook secret legacy backfill dry-run:

```bash
npm run ops:webhook-secrets:backfill -- --dry-run
```

Backup/restore drill:

```bash
export DATABASE_URL="<source-db-url>"
export RESTORE_DATABASE_URL="<restore-target-db-url>"
export BACKUP_RESTORE_CONFIRM=YES
npm run ops:backup:restore-drill
```

Ops metrics snapshot (queue + dead-letter health, optional threshold assertions):

```bash
export OPS_ASSERT_THRESHOLDS=true
export OPS_MAX_PDF_FAILED=0
export OPS_MAX_WEBHOOK_DEAD_LETTER=0
npm run ops:metrics:snapshot
```

Rollback procedure reference:
- `/Users/troysullivan/Documents/QAssess/apps/api/docs/MIGRATION_ROLLBACK_RUNBOOK.md`
