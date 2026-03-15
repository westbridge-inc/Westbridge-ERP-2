#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Westbridge ERP — Database Backup Script
#
# Usage:
#   DATABASE_URL="postgresql://..." ./scripts/db-backup.sh
#   AWS_S3_BACKUP_BUCKET=my-bucket ./scripts/db-backup.sh  # optional S3 upload
#
# Features:
#   - Compressed pg_dump with timestamp naming
#   - Optional S3 upload (requires aws CLI)
#   - 30-day local retention with automatic cleanup
#   - Structured logging for container environments
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/westbridge}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
TIMESTAMP=$(date +"%Y-%m-%d-%H%M%S")
FILENAME="westbridge-backup-${TIMESTAMP}.sql.gz"
FILEPATH="${BACKUP_DIR}/${FILENAME}"

log() { echo "{\"level\":\"info\",\"msg\":\"$1\",\"time\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"file\":\"${FILENAME}\"}" ; }
log_error() { echo "{\"level\":\"error\",\"msg\":\"$1\",\"time\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" >&2 ; }

# Validate
if [ -z "${DATABASE_URL:-}" ]; then
  log_error "DATABASE_URL is required"
  exit 1
fi

# Ensure backup directory exists
mkdir -p "${BACKUP_DIR}"

# Run pg_dump
log "Starting database backup"
if pg_dump "${DATABASE_URL}" --no-owner --no-privileges --clean --if-exists | gzip > "${FILEPATH}"; then
  SIZE=$(du -h "${FILEPATH}" | cut -f1)
  log "Backup completed: ${SIZE}"
else
  log_error "pg_dump failed"
  rm -f "${FILEPATH}"
  exit 1
fi

# Optional: Upload to S3
if [ -n "${AWS_S3_BACKUP_BUCKET:-}" ]; then
  S3_PATH="s3://${AWS_S3_BACKUP_BUCKET}/backups/${FILENAME}"
  log "Uploading to ${S3_PATH}"
  if aws s3 cp "${FILEPATH}" "${S3_PATH}" --storage-class STANDARD_IA; then
    log "S3 upload completed"
  else
    log_error "S3 upload failed (local backup preserved)"
  fi
fi

# Cleanup: remove backups older than retention period
log "Cleaning up backups older than ${RETENTION_DAYS} days"
DELETED=$(find "${BACKUP_DIR}" -name "westbridge-backup-*.sql.gz" -mtime "+${RETENTION_DAYS}" -delete -print | wc -l)
log "Deleted ${DELETED} old backup(s)"

log "Backup complete: ${FILEPATH}"
