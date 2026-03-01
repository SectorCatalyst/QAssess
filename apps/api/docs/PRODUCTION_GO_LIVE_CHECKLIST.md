# Production Go-Live Checklist

Last updated: 2026-02-26

## Release Gate

Go-live is approved only when all `P0` and `P1` items are complete.

Primary deployment/security runbook:
- `/Users/troysullivan/Documents/QAssess/apps/api/docs/DEPLOYMENT_SECURITY_RUNBOOK.md`
- `/Users/troysullivan/Documents/QAssess/apps/api/docs/BEGINNER_STEP_BY_STEP_GO_LIVE.md` (beginner walkthrough)

Legend:
- `[x]` completed in codebase
- `[ ]` required before production launch

## Implementation Order

### 1) P0 Security and Secrets (Blocker)

- [ ] Replace all shared/static secrets in production (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`) with vault-managed values.
- [x] Enforce startup secret policy support (`STRICT_SECRET_VALIDATION=true` in production).
- [x] Add application-level encryption-at-rest for webhook secrets (`WEBHOOK_SECRET_ENCRYPTION_KEY`, AES-256-GCM in code).
- [x] Add legacy webhook secret backfill command (`npm run ops:webhook-secrets:backfill`).
- [ ] Move webhook secret key management to KMS/HSM-backed runtime secret delivery.
- [ ] Enforce HTTPS-only ingress and HSTS at edge/load balancer.
- [ ] Restrict DB network access to app/worker runtime only.
- [x] Add API-level per-IP rate limiting for public endpoints:
  - `/v1/public/:slug/bootstrap`
  - `/v1/public/:slug/sessions`
  - `/v1/sessions/:sessionId/*`
- [ ] Add edge/load-balancer rate limiting + abuse protection for public endpoints:
  - `/v1/public/:slug/bootstrap`
  - `/v1/public/:slug/sessions`
  - `/v1/sessions/:sessionId/*`

### 2) P0 Data Safety and Recovery (Blocker)

- [x] Add backup + restore drill script (`npm run ops:backup:restore-drill`).
- [ ] Execute backup + restore drill against staging and retain artifact/log.
- [x] Add migration dry-run command (`npm run db:migrate:dry-run`).
- [ ] Execute migration dry-run against staging snapshot before production migration.
- [x] Add schema parity check command (`npm run ops:schema:parity`).
- [ ] Verify `schema_migrations` parity between staging and production using parity command.
- [x] Define rollback procedure for each migration batch (`docs/MIGRATION_ROLLBACK_RUNBOOK.md`).
- [ ] Approve rollback runbook owners and restore checkpoints for each batch.

### 3) P1 Runtime and Worker Operations (Blocker)

- [x] PDF worker implementation exists (`npm run worker:pdf`).
- [x] Webhook worker implementation exists (`npm run worker:webhook`).
- [x] Add supervisor/orchestrator reference templates (`deploy/systemd/*`).
- [x] Configure worker polling + batch controls (`qassess-*.timer`, `*_WORKER_BATCH_SIZE`, `WEBHOOK_WORKER_MAX_ATTEMPTS`).
- [ ] Enable workers under supervisor/orchestrator in staging and production with restart policy.
- [x] Add dead-letter replay operational script/process for `webhook_deliveries` (`npm run worker:webhook:replay`).
- [x] API readiness endpoint exists (`GET /readyz`).
- [x] Graceful shutdown handling exists (`SIGTERM`, `SIGINT`).

### 4) P1 Observability and Alerting (Blocker)

- [x] Add operational metrics snapshot + threshold checker (`npm run ops:metrics:snapshot`).
- [x] Add application-level structured log sink forwarding support (`LOG_SINK_URL`).
- [ ] Configure centralized sink destination/token in staging and production (Datadog, CloudWatch, ELK, etc.).
- [ ] Add alerts:
  - 5xx rate spikes
  - worker failure spikes
  - webhook dead-letter growth
  - DB connectivity/readiness failures
- [ ] Add dashboard panels for:
  - request volume/latency/error rate
  - queued/failed/completed PDF jobs
  - webhook pending/failed/dead-letter counts

### 5) P2 Release Quality Gates (Required before broad rollout)

- [x] Type check passes (`npm run check`).
- [x] Integration tests pass (`npm run test:integration`).
- [x] E2E tests pass (`npm run test:e2e`).
- [x] CI runs integration + e2e (`.github/workflows/api-ci.yml`).
- [x] Add load test baseline harness for public runtime/session flow (`npm run load:baseline`).
- [ ] Capture and approve staging load baseline metrics artifact.
- [x] Add security scan step (dependency + container/image if applicable).

### 6) P2 Go-Live Runbook (Required before launch day)

- [x] Add go-live ownership/timeline template (`docs/GO_LIVE_PLAN_TEMPLATE.md`).
- [ ] Finalize deployment runbook with owner, timeline, rollback owner.
- [ ] Define launch freeze window and on-call roster.
- [x] Add automated staging smoke script/runbook (`npm run smoke:staging`, `docs/STAGING_TESTING_RUNBOOK.md`).
- [ ] Execute staging smoke test with production-like config:
  - public flow (`bootstrap -> session -> lead -> response -> complete`)
  - pdf job queue + worker completion
  - webhook delivery + retry path
  - CSV export and report retrieval

## Concrete Command Checklist

Run in `/Users/troysullivan/Documents/QAssess/apps/api`:

```bash
npm ci
npm run db:migrate
npm run check
npm test
npm run build
npm run ops:rehearsal:local
npm run ops:staging:execute
```

Worker smoke (single run):

```bash
npm run worker:pdf
npm run worker:webhook
npm run worker:webhook:replay -- --dry-run
npm run smoke:staging
npm run load:baseline
npm run db:migrate:dry-run
npm run ops:schema:parity
npm run ops:webhook-secrets:backfill -- --dry-run
npm run ops:metrics:snapshot -- --assert-thresholds
```

API health checks:

```bash
curl -fsS http://<api-host>/healthz
curl -fsS http://<api-host>/readyz
```

## Launch Sequence (Suggested)

1. Complete all `P0` items.
2. Deploy to staging and run full command checklist.
3. Run staging smoke tests and backup-restore drill.
4. Complete all `P1` items.
5. Deploy production with migration window.
6. Run post-deploy smoke checks.
7. Monitor dashboards/alerts for 60 minutes before declaring success.

## Post-Launch (First 7 Days)

- [ ] Daily review of webhook dead-letter and PDF failures.
- [ ] Daily error-budget check (5xx, latency, timeout trends).
- [ ] Confirm backup job success and restore sample validation.
