# Deployment and Security Runbook

Last updated: 2026-02-26

## Scope

This runbook defines production edge policy, load-balancer policy, ingress policy, and secret-rotation operations for QAssess API.

Use this with:
- `/Users/troysullivan/Documents/QAssess/apps/api/docs/PRODUCTION_GO_LIVE_CHECKLIST.md`
- `/Users/troysullivan/Documents/QAssess/apps/api/docs/STAGING_TESTING_RUNBOOK.md`
- `/Users/troysullivan/Documents/QAssess/apps/api/docs/MIGRATION_ROLLBACK_RUNBOOK.md`
- `/Users/troysullivan/Documents/QAssess/apps/api/docs/GO_LIVE_PLAN_TEMPLATE.md`

## Target Topology

`Client -> Cloudflare -> AWS ALB (+ AWS WAF) -> NGINX ingress/reverse proxy -> QAssess API + workers`

## Canonical Public Rate-Limit Policy

These are the canonical values and should match all layers:

- `GET /v1/public/:slug/bootstrap`: `120 req/min/IP`
- `POST /v1/public/:slug/sessions`: `60 req/min/IP`
- `POST|PUT|GET /v1/sessions/:sessionId/*` and `GET /v1/pdf-jobs/:jobId`: `180 req/min/IP`

Current API-level enforcement is implemented in code via env:
- `PUBLIC_BOOTSTRAP_RATE_LIMIT_PER_MINUTE`
- `PUBLIC_SESSION_START_RATE_LIMIT_PER_MINUTE`
- `PUBLIC_SESSION_MUTATION_RATE_LIMIT_PER_MINUTE`

## Cloudflare Edge Policy (Exact Rules)

Configure 3 Cloudflare Rate Limiting Rules with these exact match expressions.

Rule `qassess-bootstrap-120rpm`:
- Expression:
```txt
(http.request.method eq "GET" and http.request.uri.path matches "^/v1/public/[^/]+/bootstrap$")
```
- Threshold: `120 requests`
- Period: `60 seconds`
- Counting characteristic: `IP`
- Action: `Managed Challenge`
- Mitigation timeout: `60 seconds`

Rule `qassess-session-start-60rpm`:
- Expression:
```txt
(http.request.method eq "POST" and http.request.uri.path matches "^/v1/public/[^/]+/sessions$")
```
- Threshold: `60 requests`
- Period: `60 seconds`
- Counting characteristic: `IP`
- Action: `Managed Challenge` (or `Block` for stricter policy)
- Mitigation timeout: `120 seconds`

Rule `qassess-session-mutation-180rpm`:
- Expression:
```txt
(
  (http.request.method in {"GET" "POST" "PUT"} and http.request.uri.path matches "^/v1/sessions/[0-9a-fA-F-]+/(lead|responses|complete|result|pdf)$")
  or
  (http.request.method eq "GET" and http.request.uri.path matches "^/v1/pdf-jobs/[0-9a-fA-F-]+$")
)
```
- Threshold: `180 requests`
- Period: `60 seconds`
- Counting characteristic: `IP`
- Action: `Managed Challenge`
- Mitigation timeout: `60 seconds`

Notes:
- Exclude health endpoints (`/healthz`, `/readyz`) from edge limits.
- Keep Cloudflare values equal or stricter than API limits.

## AWS ALB/WAF Policy (Exact Rate Limits)

AWS WAF rate-based rules are evaluated per 5-minute windows, so use:
- `120/min => 600 / 5 min`
- `60/min => 300 / 5 min`
- `180/min => 900 / 5 min`

Use WAF rules scoped to ALB with these path regex patterns:
- `^/v1/public/[^/]+/bootstrap$`
- `^/v1/public/[^/]+/sessions$`
- `^/v1/sessions/[0-9a-fA-F-]+/(lead|responses|complete|result|pdf)$`
- `^/v1/pdf-jobs/[0-9a-fA-F-]+$`

Example Terraform skeleton:

```hcl
resource "aws_wafv2_web_acl" "qassess_api" {
  name  = "qassess-api-web-acl"
  scope = "REGIONAL"

  default_action { allow {} }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "qassess-api-web-acl"
    sampled_requests_enabled   = true
  }

  # 120 rpm => 600 per 5m
  rule {
    name     = "bootstrap-rate-limit"
    priority = 10
    action { block {} }
    statement {
      rate_based_statement {
        aggregate_key_type = "IP"
        limit              = 600
        scope_down_statement {
          regex_match_statement {
            field_to_match { uri_path {} }
            regex_string = "^/v1/public/[^/]+/bootstrap$"
            text_transformation { priority = 0 type = "NONE" }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "bootstrap-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  # 60 rpm => 300 per 5m
  rule {
    name     = "session-start-rate-limit"
    priority = 20
    action { block {} }
    statement {
      rate_based_statement {
        aggregate_key_type = "IP"
        limit              = 300
        scope_down_statement {
          regex_match_statement {
            field_to_match { uri_path {} }
            regex_string = "^/v1/public/[^/]+/sessions$"
            text_transformation { priority = 0 type = "NONE" }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "session-start-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  # 180 rpm => 900 per 5m
  rule {
    name     = "session-mutation-rate-limit"
    priority = 30
    action { block {} }
    statement {
      rate_based_statement {
        aggregate_key_type = "IP"
        limit              = 900
        scope_down_statement {
          or_statement {
            statement {
              regex_match_statement {
                field_to_match { uri_path {} }
                regex_string = "^/v1/sessions/[0-9a-fA-F-]+/(lead|responses|complete|result|pdf)$"
                text_transformation { priority = 0 type = "NONE" }
              }
            }
            statement {
              regex_match_statement {
                field_to_match { uri_path {} }
                regex_string = "^/v1/pdf-jobs/[0-9a-fA-F-]+$"
                text_transformation { priority = 0 type = "NONE" }
              }
            }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "session-mutation-rate-limit"
      sampled_requests_enabled   = true
    }
  }
}

resource "aws_wafv2_web_acl_association" "qassess_api_alb" {
  resource_arn = aws_lb.qassess_api.arn
  web_acl_arn  = aws_wafv2_web_acl.qassess_api.arn
}
```

## NGINX Policy (Exact Config)

Use this ingress/reverse-proxy config snippet:

```nginx
limit_req_status 429;

limit_req_zone $binary_remote_addr zone=qassess_bootstrap:10m rate=120r/m;
limit_req_zone $binary_remote_addr zone=qassess_session_start:10m rate=60r/m;
limit_req_zone $binary_remote_addr zone=qassess_session_mutation:10m rate=180r/m;

server {
  listen 443 ssl http2;
  server_name api.example.com;

  location ~* ^/v1/public/[^/]+/bootstrap$ {
    limit_req zone=qassess_bootstrap burst=20 nodelay;
    proxy_pass http://qassess_api_upstream;
  }

  location ~* ^/v1/public/[^/]+/sessions$ {
    limit_req zone=qassess_session_start burst=10 nodelay;
    proxy_pass http://qassess_api_upstream;
  }

  location ~* ^/v1/sessions/[0-9a-fA-F-]+/(lead|responses|complete|result|pdf)$ {
    limit_req zone=qassess_session_mutation burst=30 nodelay;
    proxy_pass http://qassess_api_upstream;
  }

  location ~* ^/v1/pdf-jobs/[0-9a-fA-F-]+$ {
    limit_req zone=qassess_session_mutation burst=30 nodelay;
    proxy_pass http://qassess_api_upstream;
  }

  location / {
    proxy_pass http://qassess_api_upstream;
  }
}
```

## JWT Secret Rotation Procedure (Production)

Current behavior: single active access/refresh secret pair (no dual-signature validation).
Rotation therefore invalidates existing sessions unless dual-key support is added later.

### Pre-rotation checklist

1. Announce maintenance/auth refresh window.
2. Confirm database backup is successful.
3. Prepare new secrets:

```bash
openssl rand -base64 48  # access
openssl rand -base64 48  # refresh
```

4. Ensure secrets are different and length >= 32.

### Rotation steps

1. Store new values in secret manager:
   - `JWT_ACCESS_SECRET`
   - `JWT_REFRESH_SECRET`
2. Revoke all active refresh tokens:

```sql
UPDATE refresh_tokens
SET revoked_at = now(),
    revoke_reason = 'secret_rotation'
WHERE revoked_at IS NULL;
```

3. Deploy API + worker processes with new secrets.
4. Verify:
   - `/healthz` and `/readyz` return success.
   - login and refresh endpoints function.
   - previous refresh token no longer works.

### Post-rotation validation

- Monitor 401/403 rates for 30 minutes.
- Confirm no startup validation errors with `STRICT_SECRET_VALIDATION=true`.

## Webhook Secret Rotation Procedure

Goal: rotate per-endpoint shared secret with no delivery interruption.

Storage model:
- `webhook_endpoints.secret_encrypted` is now encrypted at rest in application code (AES-256-GCM).
- Configure `WEBHOOK_SECRET_ENCRYPTION_KEY` in runtime environment.
- Existing plaintext rows can be backfilled with:
  - `npm run ops:webhook-secrets:backfill -- --dry-run`
  - `npm run ops:webhook-secrets:backfill`

1. Update webhook consumer to accept both old and new signatures temporarily.
2. PATCH endpoint with new secret:

```bash
curl -X PATCH "https://api.example.com/v1/integrations/webhooks/<endpointId>" \
  -H "Authorization: Bearer <owner_or_editor_token>" \
  -H "Content-Type: application/json" \
  -d '{"secret":"<new-secret-value-32+-chars>"}'
```

3. Run webhook worker and verify successful deliveries.
4. Remove old secret from consumer after stable 2xx confirmation window.

## TLS and Network Minimum Controls

- Enforce TLS 1.2+ at edge and ALB.
- Redirect HTTP -> HTTPS at edge.
- Enable HSTS (`max-age=31536000; includeSubDomains`).
- Security groups/NACL:
  - ALB ingress only 443 from internet.
  - API ingress only from ALB/ingress layer.
- DB ingress only from API/worker security groups.

## Observability Wiring (Production)

Structured logs:

- App emits JSON logs to stdout by default.
- Optional sink forwarding can be enabled with:
  - `LOG_SINK_URL`
  - `LOG_SINK_TOKEN`
  - `LOG_SINK_TIMEOUT_MS`
  - `LOG_SERVICE_NAME`

Operational queue/retry snapshot:

```bash
export OPS_ASSERT_THRESHOLDS=true
export OPS_MAX_PDF_FAILED=0
export OPS_MAX_WEBHOOK_DEAD_LETTER=0
npm run ops:metrics:snapshot
```

Recommended alert inputs:
- `pdf.failed` (should stay at `0` under normal operations)
- `webhook.dead_letter`
- `webhook.dead_letter_15m`
- API readiness failures from `GET /readyz`

## Deployment Order (Production Change Window)

1. Apply Cloudflare rules (challenge mode initially).
2. Apply AWS WAF rules to ALB.
3. Apply NGINX limits.
4. Deploy API configuration (`STRICT_SECRET_VALIDATION=true`, rate-limit env vars).
5. Run smoke:
   - `GET /healthz`
   - `GET /readyz`
   - public assessment bootstrap/session start
6. Promote Cloudflare action from challenge to block only if attack pressure persists.

## Worker Supervision Reference

Reference systemd templates are provided at:
- `/Users/troysullivan/Documents/QAssess/apps/api/deploy/systemd`

Operational baseline:
- API service: always-on (`qassess-api.service`)
- PDF worker schedule: every `60s` (`qassess-pdf-worker.timer`)
- Webhook worker schedule: every `30s` (`qassess-webhook-worker.timer`)
- Dead-letter replay: on-demand (`qassess-webhook-replay.service`)

Install and verification steps:
- `/Users/troysullivan/Documents/QAssess/apps/api/deploy/systemd/README.md`
