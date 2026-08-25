#!/usr/bin/env bash
#
# Database backup. Runs every six hours from cron (or the `backup` service in
# docker-compose), gzips the dump and pushes it to an S3-compatible bucket.
#
# A backup nobody has restored is not a backup — see ops/restore.sh and the
# verification step in DEPLOY.md.
set -Eeuo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="${BACKUP_DIR}/alnotica-${STAMP}.sql.gz"

mkdir -p "${BACKUP_DIR}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

alert() {
  # A silent backup failure is the worst kind. Tell someone.
  if [[ -n "${ALERT_TG_TOKEN:-}" && -n "${ALERT_TG_CHAT:-}" ]]; then
    curl -sS --max-time 10 \
      "https://api.telegram.org/bot${ALERT_TG_TOKEN}/sendMessage" \
      -d "chat_id=${ALERT_TG_CHAT}" \
      --data-urlencode "text=Бэкап не удался: $*" >/dev/null || true
  fi
}

trap 'alert "шаг $BASH_COMMAND"; log "backup failed"; exit 1' ERR

log "dumping to ${FILE}"
# --clean --if-exists so the dump can be replayed onto a non-empty database.
pg_dump --no-owner --no-privileges --clean --if-exists "${DATABASE_URL}" \
  | gzip -9 > "${FILE}"

SIZE="$(stat -c %s "${FILE}")"
if (( SIZE < 1024 )); then
  log "dump is suspiciously small (${SIZE} bytes)"
  exit 1
fi
log "dump complete: ${SIZE} bytes"

# Prove the archive is readable before it is trusted or uploaded.
gzip -t "${FILE}"

if [[ -n "${S3_BUCKET:-}" ]]; then
  log "uploading to ${S3_BUCKET}"
  aws s3 cp "${FILE}" "s3://${S3_BUCKET}/$(basename "${FILE}")" \
    ${S3_ENDPOINT:+--endpoint-url "${S3_ENDPOINT}"} \
    --only-show-errors
  log "upload complete"
else
  log "S3_BUCKET is not set; keeping the dump locally only"
fi

# Local retention. Remote retention is a bucket lifecycle rule (see DEPLOY.md).
find "${BACKUP_DIR}" -name 'alnotica-*.sql.gz' -mtime "+${RETENTION_DAYS}" -delete
log "done"
