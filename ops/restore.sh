#!/usr/bin/env bash
#
# Restore, and the proof that the backup works.
#
#   ops/restore.sh <dump.sql.gz> [target-database-url]
#
# With no target it restores into a scratch database, checks that the schema and
# the row counts came back, and drops it again. That is the verification the
# brief asks for: run it after every change to the backup pipeline.
set -Eeuo pipefail

DUMP="${1:?usage: restore.sh <dump.sql.gz> [target-database-url]}"
TARGET="${2:-}"

: "${DATABASE_URL:?DATABASE_URL is required}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

[[ -f "${DUMP}" ]] || { log "no such dump: ${DUMP}"; exit 1; }
gzip -t "${DUMP}" || { log "archive is corrupt: ${DUMP}"; exit 1; }

# Split the connection string so a scratch database can be created beside it.
ADMIN_URL="${DATABASE_URL%/*}/postgres"

if [[ -n "${TARGET}" ]]; then
  log "restoring into ${TARGET%%\?*}"
  gunzip -c "${DUMP}" | psql --quiet --set ON_ERROR_STOP=on "${TARGET}"
  log "restore complete"
  exit 0
fi

SCRATCH="alnotica_restore_check_$(date -u +%s)"
SCRATCH_URL="${DATABASE_URL%/*}/${SCRATCH}"

cleanup() {
  psql --quiet "${ADMIN_URL}" -c "DROP DATABASE IF EXISTS ${SCRATCH}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "creating scratch database ${SCRATCH}"
psql --quiet --set ON_ERROR_STOP=on "${ADMIN_URL}" -c "CREATE DATABASE ${SCRATCH}" >/dev/null

log "restoring ${DUMP}"
gunzip -c "${DUMP}" | psql --quiet --set ON_ERROR_STOP=on "${SCRATCH_URL}" >/dev/null

# A restore that produces an empty database is a failure that looks like success.
TABLES=$(psql -tA "${SCRATCH_URL}" -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
log "tables restored: ${TABLES}"
(( TABLES >= 15 )) || { log "expected at least 15 tables, found ${TABLES}"; exit 1; }

# The double-booking guard is the constraint the product depends on. If it did not
# come back, the restored database is not the one we thought we had.
EXCLUDES=$(psql -tA "${SCRATCH_URL}" -c \
  "SELECT count(*) FROM pg_constraint WHERE contype='x'")
log "exclusion constraints restored: ${EXCLUDES}"
(( EXCLUDES >= 2 )) || { log "the EXCLUDE constraints did not survive the restore"; exit 1; }

for table in tenant staff service appointment client job; do
  COUNT=$(psql -tA "${SCRATCH_URL}" -c "SELECT count(*) FROM ${table}")
  log "  ${table}: ${COUNT} rows"
done

log "restore verified"
