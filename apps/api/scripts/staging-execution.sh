#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_ROOT="${ROOT_DIR}/artifacts"
RUN_TS="$(date +%Y%m%d-%H%M%S)"
RUN_DIR="${ARTIFACT_ROOT}/staging-exec-${RUN_TS}"

mkdir -p "${RUN_DIR}"

print_help() {
  cat <<'EOF'
QAssess staging execution runner

Usage:
  npm run ops:staging:execute

Required env:
  API_BASE_URL
  SMOKE_TENANT_SLUG
  SMOKE_EMAIL
  SMOKE_PASSWORD
  DATABASE_URL
  MIGRATION_DRY_RUN_DATABASE_URL
  SCHEMA_SOURCE_DATABASE_URL
  SCHEMA_TARGET_DATABASE_URL
  WEBHOOK_SECRET_ENCRYPTION_KEY (or JWT_REFRESH_SECRET fallback)

Optional env:
  STAGING_ASSESSMENT_SLUG                 # Skip slug parsing from smoke output
  SMOKE_REQUIRE_PDF_COMPLETED=true
  LOAD_TOTAL_SESSIONS=30
  LOAD_CONCURRENCY=2
  LOAD_WARMUP_SESSIONS=10
  LOAD_INCLUDE_COMPLETE=true
  LOAD_ASSERT_THRESHOLDS=true
  OPS_ASSERT_THRESHOLDS=true
  OPS_MAX_PDF_FAILED=0
  OPS_MAX_WEBHOOK_DEAD_LETTER=0

Optional backup/restore drill:
  RUN_BACKUP_RESTORE_DRILL=true
  RESTORE_DATABASE_URL=<restore-target-db-url>
  BACKUP_RESTORE_CONFIRM=YES

Output:
  Artifacts in apps/api/artifacts/staging-exec-<timestamp>/
EOF
}

log() {
  printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"
}

run_and_capture() {
  local label="$1"
  shift
  local output_file="${RUN_DIR}/${label}.log"
  log "Running ${label}: $*"
  {
    printf '>>> COMMAND:'
    printf ' %q' "$@"
    printf '\n\n'
    "$@"
  } | tee "${output_file}"
}

required_env() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "${value}" ]]; then
    printf 'Missing required environment variable: %s\n' "${name}" >&2
    exit 1
  fi
}

extract_slug_from_smoke_log() {
  local smoke_log="$1"
  grep -Eo 'slug=[^ ]+' "${smoke_log}" | tail -n 1 | cut -d '=' -f 2
}

main() {
  if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    print_help
    exit 0
  fi

  required_env API_BASE_URL
  required_env SMOKE_TENANT_SLUG
  required_env SMOKE_EMAIL
  required_env SMOKE_PASSWORD
  required_env DATABASE_URL
  required_env MIGRATION_DRY_RUN_DATABASE_URL
  required_env SCHEMA_SOURCE_DATABASE_URL
  required_env SCHEMA_TARGET_DATABASE_URL

  if [[ -z "${WEBHOOK_SECRET_ENCRYPTION_KEY:-}" && -z "${JWT_REFRESH_SECRET:-}" ]]; then
    printf 'Missing required webhook encryption env: WEBHOOK_SECRET_ENCRYPTION_KEY (or JWT_REFRESH_SECRET fallback)\n' >&2
    exit 1
  fi

  log "Artifacts will be written to ${RUN_DIR}"

  run_and_capture smoke-staging bash -lc "cd '${ROOT_DIR}' && API_BASE_URL='${API_BASE_URL}' SMOKE_TENANT_SLUG='${SMOKE_TENANT_SLUG}' SMOKE_EMAIL='${SMOKE_EMAIL}' SMOKE_PASSWORD='${SMOKE_PASSWORD}' SMOKE_REQUIRE_PDF_COMPLETED='${SMOKE_REQUIRE_PDF_COMPLETED:-true}' npm run smoke:staging"

  local slug="${STAGING_ASSESSMENT_SLUG:-}"
  if [[ -z "${slug}" ]]; then
    slug="$(extract_slug_from_smoke_log "${RUN_DIR}/smoke-staging.log")"
  fi
  if [[ -z "${slug}" ]]; then
    log "Could not determine assessment slug. Set STAGING_ASSESSMENT_SLUG and rerun."
    exit 1
  fi
  log "Using assessment slug for load test: ${slug}"

  run_and_capture load-baseline bash -lc "cd '${ROOT_DIR}' && API_BASE_URL='${API_BASE_URL}' ASSESSMENT_SLUG='${slug}' LOAD_TOTAL_SESSIONS='${LOAD_TOTAL_SESSIONS:-30}' LOAD_CONCURRENCY='${LOAD_CONCURRENCY:-2}' LOAD_WARMUP_SESSIONS='${LOAD_WARMUP_SESSIONS:-10}' LOAD_INCLUDE_COMPLETE='${LOAD_INCLUDE_COMPLETE:-true}' LOAD_ASSERT_THRESHOLDS='${LOAD_ASSERT_THRESHOLDS:-true}' npm run load:baseline"

  run_and_capture migration-dry-run bash -lc "cd '${ROOT_DIR}' && DATABASE_URL='${DATABASE_URL}' MIGRATION_DRY_RUN_DATABASE_URL='${MIGRATION_DRY_RUN_DATABASE_URL}' npm run db:migrate:dry-run"
  run_and_capture schema-parity bash -lc "cd '${ROOT_DIR}' && SCHEMA_SOURCE_DATABASE_URL='${SCHEMA_SOURCE_DATABASE_URL}' SCHEMA_TARGET_DATABASE_URL='${SCHEMA_TARGET_DATABASE_URL}' npm run ops:schema:parity"

  run_and_capture webhook-secrets-backfill-dry-run bash -lc "cd '${ROOT_DIR}' && DATABASE_URL='${DATABASE_URL}' WEBHOOK_SECRET_ENCRYPTION_KEY='${WEBHOOK_SECRET_ENCRYPTION_KEY:-}' JWT_REFRESH_SECRET='${JWT_REFRESH_SECRET:-}' npm run ops:webhook-secrets:backfill -- --dry-run"

  run_and_capture webhook-replay-dry-run bash -lc "cd '${ROOT_DIR}' && DATABASE_URL='${DATABASE_URL}' npm run worker:webhook:replay -- --dry-run"

  run_and_capture metrics-snapshot bash -lc "cd '${ROOT_DIR}' && DATABASE_URL='${DATABASE_URL}' OPS_ASSERT_THRESHOLDS='${OPS_ASSERT_THRESHOLDS:-true}' OPS_MAX_PDF_FAILED='${OPS_MAX_PDF_FAILED:-0}' OPS_MAX_WEBHOOK_DEAD_LETTER='${OPS_MAX_WEBHOOK_DEAD_LETTER:-0}' npm run ops:metrics:snapshot"

  if [[ "${RUN_BACKUP_RESTORE_DRILL:-false}" == "true" ]]; then
    required_env RESTORE_DATABASE_URL
    required_env BACKUP_RESTORE_CONFIRM
    run_and_capture backup-restore-drill bash -lc "cd '${ROOT_DIR}' && DATABASE_URL='${DATABASE_URL}' RESTORE_DATABASE_URL='${RESTORE_DATABASE_URL}' BACKUP_RESTORE_CONFIRM='${BACKUP_RESTORE_CONFIRM}' BACKUP_ARTIFACT_DIR='${RUN_DIR}' npm run ops:backup:restore-drill"
  else
    log "Skipping backup/restore drill (set RUN_BACKUP_RESTORE_DRILL=true to include it)."
  fi

  local summary_file="${RUN_DIR}/SUMMARY.txt"
  {
    printf 'Staging execution PASS\n'
    printf 'Run directory: %s\n' "${RUN_DIR}"
    printf 'API base URL: %s\n' "${API_BASE_URL}"
    printf 'Assessment slug: %s\n' "${slug}"
    printf 'Included backup/restore drill: %s\n' "${RUN_BACKUP_RESTORE_DRILL:-false}"
  } >"${summary_file}"

  log "Staging execution complete. Summary: ${summary_file}"
}

main "$@"
