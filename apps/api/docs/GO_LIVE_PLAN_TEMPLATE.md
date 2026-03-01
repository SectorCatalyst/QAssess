# Go-Live Plan Template

Last updated: 2026-02-26

Use this file as the launch-day control document. Fill all `TBD` values before production cutover.

## Ownership

- Launch owner: `TBD`
- Rollback owner: `TBD`
- Database migration owner: `TBD`
- Worker/runtime owner: `TBD`
- Communications owner: `TBD`

## Launch Timeline (UTC or local timezone, choose one and keep consistent)

| Time | Step | Owner | Evidence required |
| --- | --- | --- | --- |
| `TBD` | Freeze starts (code + config) | `TBD` | Freeze announcement sent |
| `TBD` | Preflight health checks | `TBD` | `/healthz` + `/readyz` success |
| `TBD` | Backup snapshot capture | `TBD` | Snapshot ID recorded |
| `TBD` | Migration execution | `TBD` | `db:migrate` logs |
| `TBD` | API + worker deploy | `TBD` | Deployment version recorded |
| `TBD` | Smoke execution | `TBD` | `smoke:staging`/prod smoke artifact |
| `TBD` | Observability check | `TBD` | Alerts green, queue metrics healthy |
| `TBD` | Launch complete announcement | `TBD` | Stakeholder notice sent |

## Freeze Window

- Freeze start: `TBD`
- Freeze end: `TBD`
- Allowed exceptions during freeze: `TBD`

## On-Call Roster (First 24h)

| Role | Person | Contact | Backup |
| --- | --- | --- | --- |
| API primary | `TBD` | `TBD` | `TBD` |
| DB primary | `TBD` | `TBD` | `TBD` |
| Infra primary | `TBD` | `TBD` | `TBD` |
| Product/Support | `TBD` | `TBD` | `TBD` |

## Rollback Decision Gates

Trigger rollback if any of the following persists for 10 minutes after deploy:

- `readyz` is failing.
- 5xx error rate is above agreed threshold.
- PDF `failed` or webhook `dead_letter` counts exceed thresholds.
- Smoke path fails (`bootstrap -> session -> lead -> response -> complete -> report/pdf`).

Rollback authority:

- Primary: rollback owner
- Secondary: launch owner when rollback owner is unavailable

Rollback runbook:

- `/Users/troysullivan/Documents/QAssess/apps/api/docs/MIGRATION_ROLLBACK_RUNBOOK.md`
