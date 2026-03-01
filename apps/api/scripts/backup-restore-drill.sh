#!/usr/bin/env bash
set -euo pipefail

if [[ "${BACKUP_RESTORE_CONFIRM:-}" != "YES" ]]; then
  echo "Refusing to run destructive restore drill."
  echo "Set BACKUP_RESTORE_CONFIRM=YES to proceed."
  exit 1
fi

SOURCE_DB_URL="${DATABASE_URL:-}"
RESTORE_DB_URL="${RESTORE_DATABASE_URL:-}"

if [[ -z "$SOURCE_DB_URL" ]]; then
  echo "Missing DATABASE_URL"
  exit 1
fi
if [[ -z "$RESTORE_DB_URL" ]]; then
  echo "Missing RESTORE_DATABASE_URL"
  exit 1
fi

ts="$(date +%Y%m%d-%H%M%S)"
artifact_dir="${BACKUP_ARTIFACT_DIR:-./artifacts}"
mkdir -p "$artifact_dir"
dump_file="${artifact_dir}/backup-drill-${ts}.sql"

echo "Creating backup dump: ${dump_file}"
pg_dump --no-owner --no-privileges "$SOURCE_DB_URL" > "$dump_file"

echo "Resetting restore target schema..."
psql "$RESTORE_DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO public;
SQL

echo "Restoring into restore target..."
psql "$RESTORE_DB_URL" -v ON_ERROR_STOP=1 -f "$dump_file" >/tmp/qassess-restore-drill.log

echo "Verifying restored tables..."
required_tables=(
  "schema_migrations"
  "tenants"
  "users"
  "assessments"
  "assessment_versions"
  "sessions"
  "results"
  "webhook_endpoints"
  "webhook_deliveries"
)

for table_name in "${required_tables[@]}"; do
  exists="$(psql "$RESTORE_DB_URL" -Atqc "SELECT to_regclass('public.${table_name}') IS NOT NULL;")"
  if [[ "$exists" != "t" ]]; then
    echo "Restore verification failed: missing table ${table_name}"
    exit 1
  fi
done

migration_count="$(psql "$RESTORE_DB_URL" -Atqc "SELECT COUNT(*) FROM schema_migrations;")"
if [[ "${migration_count}" -lt 1 ]]; then
  echo "Restore verification failed: schema_migrations is empty"
  exit 1
fi

echo "Backup/restore drill PASS"
echo "Backup artifact: ${dump_file}"
echo "Restore log: /tmp/qassess-restore-drill.log"
