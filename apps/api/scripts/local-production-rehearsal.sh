#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_ROOT="${ROOT_DIR}/artifacts"
RUN_TS="$(date +%Y%m%d-%H%M%S)"
RUN_DIR="${ARTIFACT_ROOT}/local-rehearsal-${RUN_TS}"

MAIN_DB_URL="${MAIN_DB_URL:-postgresql://postgres@127.0.0.1:5432/qassess}"
DRYRUN_DB_URL="${DRYRUN_DB_URL:-postgresql://postgres@127.0.0.1:5432/qassess_dryrun}"
RESTORE_DB_URL="${RESTORE_DB_URL:-postgresql://postgres@127.0.0.1:5432/qassess_restore}"

API_PORT="${API_PORT:-4000}"
API_BASE_URL="http://127.0.0.1:${API_PORT}"

API_PID=""
PDF_LOOP_PID=""
WEBHOOK_LOOP_PID=""

mkdir -p "${RUN_DIR}"

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

cleanup() {
  if [[ -n "${PDF_LOOP_PID}" ]] && kill -0 "${PDF_LOOP_PID}" >/dev/null 2>&1; then
    kill "${PDF_LOOP_PID}" >/dev/null 2>&1 || true
    wait "${PDF_LOOP_PID}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${WEBHOOK_LOOP_PID}" ]] && kill -0 "${WEBHOOK_LOOP_PID}" >/dev/null 2>&1; then
    kill "${WEBHOOK_LOOP_PID}" >/dev/null 2>&1 || true
    wait "${WEBHOOK_LOOP_PID}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${API_PID}" ]] && kill -0 "${API_PID}" >/dev/null 2>&1; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

create_or_reset_database() {
  local db_name="$1"
  log "Recreating database ${db_name}"
  psql "postgresql://postgres@127.0.0.1:5432/postgres" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${db_name};"
  psql "postgresql://postgres@127.0.0.1:5432/postgres" -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${db_name};"
}

start_worker_loop() {
  local script_name="$1"
  local interval_seconds="$2"
  local out_file="${RUN_DIR}/${script_name}-loop.log"

  (
    while true; do
      (
        cd "${ROOT_DIR}"
        DATABASE_URL="${MAIN_DB_URL}" \
        JWT_ACCESS_SECRET='dev_access_secret_qassess_local_2026_ABCDEFGHIJKLMNOPQRSTUVWXYZ' \
        JWT_REFRESH_SECRET='dev_refresh_secret_qassess_local_2026_1234567890abcdefghijk' \
        WEBHOOK_SECRET_ENCRYPTION_KEY='dev_webhook_secret_qassess_local_2026_encryption_key_12345' \
        STRICT_SECRET_VALIDATION=false \
        npm run "${script_name}" >>"${out_file}" 2>&1
      ) || true
      sleep "${interval_seconds}"
    done
  ) >/dev/null 2>&1 &

  echo "$!"
}

start_api() {
  local out_file="${RUN_DIR}/api.log"
  log "Starting API on ${API_BASE_URL}"

  (
    cd "${ROOT_DIR}"
    NODE_ENV=development \
    PORT="${API_PORT}" \
    DATABASE_URL="${MAIN_DB_URL}" \
    JWT_ACCESS_SECRET='dev_access_secret_qassess_local_2026_ABCDEFGHIJKLMNOPQRSTUVWXYZ' \
    JWT_REFRESH_SECRET='dev_refresh_secret_qassess_local_2026_1234567890abcdefghijk' \
    WEBHOOK_SECRET_ENCRYPTION_KEY='dev_webhook_secret_qassess_local_2026_encryption_key_12345' \
    STRICT_SECRET_VALIDATION=false \
    ACCESS_TOKEN_TTL_MINUTES=15 \
    REFRESH_TOKEN_TTL_DAYS=30 \
    PUBLIC_BOOTSTRAP_RATE_LIMIT_PER_MINUTE=120 \
    PUBLIC_SESSION_START_RATE_LIMIT_PER_MINUTE=60 \
    PUBLIC_SESSION_MUTATION_RATE_LIMIT_PER_MINUTE=180 \
    LOG_SERVICE_NAME='qassess-api' \
    npm run start >>"${out_file}" 2>&1
  ) &

  API_PID="$!"
}

wait_for_api_ready() {
  local attempts=40
  for _ in $(seq 1 "${attempts}"); do
    if curl -fsS --max-time 2 "${API_BASE_URL}/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  log "API failed to become ready. See ${RUN_DIR}/api.log"
  return 1
}

extract_slug_from_smoke_log() {
  local smoke_log="$1"
  grep -Eo 'slug=[^ ]+' "${smoke_log}" | tail -n 1 | cut -d '=' -f 2
}

main() {
  log "Artifacts will be written to ${RUN_DIR}"

  create_or_reset_database "qassess_dryrun"
  create_or_reset_database "qassess_restore"

  run_and_capture db-migrate bash -lc "cd '${ROOT_DIR}' && DATABASE_URL='${MAIN_DB_URL}' npm run db:migrate"
  run_and_capture db-seed bash -lc "psql '${MAIN_DB_URL}' -f '${ROOT_DIR}/db/seeds/0001_dev_seed.sql'"

  run_and_capture check bash -lc "cd '${ROOT_DIR}' && npm run check"
  run_and_capture test bash -lc "cd '${ROOT_DIR}' && npm test"
  run_and_capture build bash -lc "cd '${ROOT_DIR}' && npm run build"

  run_and_capture migrate-dry-run bash -lc "cd '${ROOT_DIR}' && DATABASE_URL='${MAIN_DB_URL}' MIGRATION_DRY_RUN_DATABASE_URL='${DRYRUN_DB_URL}' npm run db:migrate:dry-run"
  run_and_capture schema-parity bash -lc "cd '${ROOT_DIR}' && SCHEMA_SOURCE_DATABASE_URL='${MAIN_DB_URL}' SCHEMA_TARGET_DATABASE_URL='${DRYRUN_DB_URL}' npm run ops:schema:parity"
  run_and_capture webhook-secrets-backfill-dry-run bash -lc "cd '${ROOT_DIR}' && DATABASE_URL='${MAIN_DB_URL}' JWT_ACCESS_SECRET='dev_access_secret_qassess_local_2026_ABCDEFGHIJKLMNOPQRSTUVWXYZ' JWT_REFRESH_SECRET='dev_refresh_secret_qassess_local_2026_1234567890abcdefghijk' WEBHOOK_SECRET_ENCRYPTION_KEY='dev_webhook_secret_qassess_local_2026_encryption_key_12345' STRICT_SECRET_VALIDATION=false npm run ops:webhook-secrets:backfill -- --dry-run"

  start_api
  wait_for_api_ready

  PDF_LOOP_PID="$(start_worker_loop worker:pdf 2)"
  WEBHOOK_LOOP_PID="$(start_worker_loop worker:webhook 2)"

  run_and_capture api-healthz curl -fsS --max-time 5 "${API_BASE_URL}/healthz"
  run_and_capture api-readyz curl -fsS --max-time 5 "${API_BASE_URL}/readyz"

  run_and_capture smoke-staging bash -lc "cd '${ROOT_DIR}' && API_BASE_URL='${API_BASE_URL}' SMOKE_TENANT_SLUG='acme' SMOKE_EMAIL='owner@acme.example' SMOKE_PASSWORD='ChangeMe123!' SMOKE_REQUIRE_PDF_COMPLETED=true npm run smoke:staging"

  local slug
  slug="$(extract_slug_from_smoke_log "${RUN_DIR}/smoke-staging.log")"
  if [[ -z "${slug}" ]]; then
    log "Failed to parse assessment slug from smoke output."
    exit 1
  fi
  log "Parsed smoke assessment slug: ${slug}"

  run_and_capture load-baseline bash -lc "cd '${ROOT_DIR}' && API_BASE_URL='${API_BASE_URL}' ASSESSMENT_SLUG='${slug}' LOAD_TOTAL_SESSIONS=30 LOAD_CONCURRENCY=2 LOAD_WARMUP_SESSIONS=10 LOAD_INCLUDE_COMPLETE=true LOAD_ASSERT_THRESHOLDS=true npm run load:baseline"
  run_and_capture webhook-replay-dry-run bash -lc "cd '${ROOT_DIR}' && DATABASE_URL='${MAIN_DB_URL}' JWT_ACCESS_SECRET='dev_access_secret_qassess_local_2026_ABCDEFGHIJKLMNOPQRSTUVWXYZ' JWT_REFRESH_SECRET='dev_refresh_secret_qassess_local_2026_1234567890abcdefghijk' WEBHOOK_SECRET_ENCRYPTION_KEY='dev_webhook_secret_qassess_local_2026_encryption_key_12345' STRICT_SECRET_VALIDATION=false npm run worker:webhook:replay -- --dry-run"
  run_and_capture metrics-snapshot bash -lc "cd '${ROOT_DIR}' && DATABASE_URL='${MAIN_DB_URL}' OPS_ASSERT_THRESHOLDS=true OPS_MAX_PDF_FAILED=0 OPS_MAX_WEBHOOK_DEAD_LETTER=0 npm run ops:metrics:snapshot"

  run_and_capture backup-restore-drill bash -lc "cd '${ROOT_DIR}' && DATABASE_URL='${MAIN_DB_URL}' RESTORE_DATABASE_URL='${RESTORE_DB_URL}' BACKUP_RESTORE_CONFIRM=YES BACKUP_ARTIFACT_DIR='${RUN_DIR}' npm run ops:backup:restore-drill"

  local summary_file="${RUN_DIR}/SUMMARY.txt"
  {
    printf 'Local production rehearsal PASS\n'
    printf 'Run directory: %s\n' "${RUN_DIR}"
    printf 'API base URL used: %s\n' "${API_BASE_URL}"
    printf 'Smoke assessment slug: %s\n' "${slug}"
  } >"${summary_file}"

  log "Rehearsal complete. Summary: ${summary_file}"
}

main "$@"
