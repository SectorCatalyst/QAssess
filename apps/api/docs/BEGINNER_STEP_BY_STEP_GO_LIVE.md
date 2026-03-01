# Beginner Step-by-Step Go-Live Guide

Last updated: 2026-02-27

This guide is written for non-engineers. It explains:

1. what each step means,
2. where to do it,
3. why we do it,
4. exactly what to run.

Use this together with:
- `/Users/troysullivan/Documents/QAssess/apps/api/docs/PRODUCTION_GO_LIVE_CHECKLIST.md`
- `/Users/troysullivan/Documents/QAssess/apps/api/docs/DEPLOYMENT_SECURITY_RUNBOOK.md`

## Acronyms (Simple)

- `API`: Application Programming Interface. The backend URL your app calls.
- `DB`: Database (where your app data is stored).
- `TLS`: Encryption for traffic over the internet (the lock icon in browser).
- `HSTS`: A browser rule that forces HTTPS only.
- `WAF`: Web Application Firewall. Blocks abusive traffic.
- `ALB`: AWS Application Load Balancer (AWS traffic entry point).
- `KMS`: AWS Key Management Service (managed encryption keys).
- `JWT`: Login token secret used by your API.
- `DNS`: Domain Name System (maps domain name to server).
- `CI`: Continuous Integration (automated test pipeline).

## Part 1: Run Staging Checks (One Command)

Where: your terminal, in `/Users/troysullivan/Documents/QAssess/apps/api`

Why: proves staging is healthy before production.

### 1) Export staging variables

```bash
cd /Users/troysullivan/Documents/QAssess/apps/api

export API_BASE_URL="https://api.staging.yourdomain.com"
export SMOKE_TENANT_SLUG="acme"
export SMOKE_EMAIL="owner@acme.example"
export SMOKE_PASSWORD="<staging-password>"

export DATABASE_URL="<staging-db-url>"
export MIGRATION_DRY_RUN_DATABASE_URL="<staging-snapshot-db-url>"
export SCHEMA_SOURCE_DATABASE_URL="<production-db-url>"
export SCHEMA_TARGET_DATABASE_URL="<staging-db-url>"

export WEBHOOK_SECRET_ENCRYPTION_KEY="<staging-webhook-encryption-key>"
export OPS_ASSERT_THRESHOLDS=true
export OPS_MAX_PDF_FAILED=0
export OPS_MAX_WEBHOOK_DEAD_LETTER=0
```

### 2) Run the staging executor

```bash
npm run ops:staging:execute
```

### 3) Find results

Artifacts are written in:
- `apps/api/artifacts/staging-exec-<timestamp>/`

Open:
- `SUMMARY.txt`
- `smoke-staging.log`
- `load-baseline.log`
- `metrics-snapshot.log`

## Part 2: Configure Secrets (AWS Secrets Manager + KMS)

Where: AWS Console

Why: secrets must not live in code or plain files.

### 1) Open AWS Secrets Manager

Path:
- AWS Console -> `Secrets Manager` -> `Store a new secret`

Create/update these keys for staging and production:
- `DATABASE_URL`
- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`
- `WEBHOOK_SECRET_ENCRYPTION_KEY`

Rules:
- JWT secrets must be long and unique (32+ characters).
- `WEBHOOK_SECRET_ENCRYPTION_KEY` should be separate from JWT secrets.

### 2) Use KMS-managed encryption

Path:
- AWS Console -> `KMS` -> create/select customer-managed key.

Then in Secrets Manager:
- set encryption key for your secret to that KMS key.

## Part 3: Configure Edge Security (Cloudflare)

Where: Cloudflare Dashboard

Why: stop bad traffic before it reaches your servers.

Path:
- Cloudflare -> your domain -> `Security` -> `WAF` -> `Rate limiting rules`

Create three rules using exact expressions from:
- `/Users/troysullivan/Documents/QAssess/apps/api/docs/DEPLOYMENT_SECURITY_RUNBOOK.md`

Also:
- enable HTTPS-only redirect
- enable HSTS

## Part 4: Configure AWS WAF + ALB

Where: AWS Console

Why: second layer of traffic protection.

Path:
- AWS Console -> `WAF & Shield` -> Web ACLs
- attach ACL to your ALB

Use the exact rate values and path patterns in:
- `/Users/troysullivan/Documents/QAssess/apps/api/docs/DEPLOYMENT_SECURITY_RUNBOOK.md`

## Part 5: Enable API + Workers on Server (systemd)

Where: staging/prod Linux server terminal

Why: API and workers must auto-start and auto-restart.

Run:

```bash
cd /Users/troysullivan/Documents/QAssess/apps/api
sudo mkdir -p /etc/qassess
sudo cp deploy/systemd/api.env.example /etc/qassess/api.env
sudo cp deploy/systemd/qassess-*.service /etc/systemd/system/
sudo cp deploy/systemd/qassess-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now qassess-api.service
sudo systemctl enable --now qassess-pdf-worker.timer
sudo systemctl enable --now qassess-webhook-worker.timer
```

Verify:

```bash
sudo systemctl status qassess-api.service --no-pager
sudo systemctl status qassess-pdf-worker.timer --no-pager
sudo systemctl status qassess-webhook-worker.timer --no-pager
```

## Part 6: Logging, Alerts, Dashboard

Where: your monitoring tool (CloudWatch, Datadog, ELK, etc.)

Why: you need automatic warnings before users report issues.

Minimum:
- logs from API and workers are centralized
- alerts for:
  - API 5xx error spikes
  - webhook dead-letter growth
  - worker failure spikes
  - readiness failures (`/readyz`)
- dashboard panels for:
  - request volume/latency/error rate
  - PDF job queued/completed/failed
  - webhook pending/failed/dead-letter

## Part 7: Final Go-Live Admin Tasks

Fill this template:
- `/Users/troysullivan/Documents/QAssess/apps/api/docs/GO_LIVE_PLAN_TEMPLATE.md`

Required before launch:
- launch owner
- rollback owner
- freeze window
- on-call roster
- rollback checkpoint confirmation

## When You’re Ready

Send me:

1. the `staging-exec-.../SUMMARY.txt` file content,
2. screenshots or copied values from Cloudflare WAF rules,
3. confirmation that systemd timers are active,
4. your alert/dashboard links.

I will then walk you through final production cutover step-by-step.
