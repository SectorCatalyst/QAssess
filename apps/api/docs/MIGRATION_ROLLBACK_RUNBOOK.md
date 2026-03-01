# Migration Rollback Runbook

Last updated: 2026-02-26

This runbook defines rollback steps for each migration batch in `/Users/troysullivan/Documents/QAssess/apps/api/db/migrations`.

## Rollback Model

Current migrations are forward-only SQL. Rollback is executed by:

1. Stop write traffic (maintenance mode or temporary 503 at edge).
2. Roll back API/worker deploy to the previous release artifact.
3. Restore database from the pre-batch backup snapshot.
4. Run smoke checks and reopen traffic.

## Batch Rollback Matrix

| Batch | Migration file | Pre-batch backup label | Rollback trigger | Rollback action |
| --- | --- | --- | --- | --- |
| 1 | `0001_m1_foundation.sql` | `pre-m1-foundation` | Auth/session startup failures, critical schema mismatch | Restore `pre-m1-foundation` snapshot, redeploy previous API image |
| 2 | `0002_m2_authoring.sql` | `pre-m2-authoring` | Authoring route failures (`/v1/assessments`, `/v1/versions`) | Restore `pre-m2-authoring` snapshot, redeploy previous API image |
| 3 | `0003_m3_landing_builder.sql` | `pre-m3-landing-builder` | Landing block/page mutation failures | Restore `pre-m3-landing-builder` snapshot, redeploy previous API image |
| 4 | `0004_m4_runtime_sessions.sql` | `pre-m4-runtime-sessions` | Public runtime/session failures or result write failures | Restore `pre-m4-runtime-sessions` snapshot, redeploy previous API image |
| 5 | `0005_m5_reports_analytics_integrations.sql` | `pre-m5-platform` | PDF/webhook/report/export failures | Restore `pre-m5-platform` snapshot, redeploy previous API image |

## Required Commands During Change Window

Run from `/Users/troysullivan/Documents/QAssess/apps/api`:

```bash
npm run db:migrate:dry-run
npm run ops:schema:parity
npm run smoke:staging
```

Before each production migration batch:

1. Capture backup snapshot with the batch label above.
2. Confirm backup is restorable.
3. Record snapshot ID in change ticket.

If rollback is triggered:

1. Capture failure evidence (migration logs, API error logs, failing endpoint payloads).
2. Restore the pre-batch snapshot.
3. Re-run:
   - `curl -fsS http://<api-host>/healthz`
   - `curl -fsS http://<api-host>/readyz`
   - `npm run smoke:staging` against rollback environment
4. Keep traffic blocked until smoke checks pass.
