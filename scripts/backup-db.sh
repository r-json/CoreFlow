#!/usr/bin/env bash
# Automated PostgreSQL Backup Script for CoreFlow
# Performs pg_dump snapshot and stores backup locally / uploads to cloud storage bucket

set -e

BACKUP_DIR="./backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/coreflow_backup_${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

echo "=================================================="
echo "[CoreFlow Backup] Starting database snapshot at ${TIMESTAMP}..."
echo "=================================================="

if [ -z "$DATABASE_URL" ]; then
  echo "[Error] DATABASE_URL environment variable is not set."
  exit 1
fi

pg_dump "$DATABASE_URL" | gzip > "$BACKUP_FILE"

echo "[Success] Database snapshot written to ${BACKUP_FILE} ($(du -h "$BACKUP_FILE" | cut -f1))"

# Cloud Backup Upload Hook (S3 / Supabase Storage fallback)
if [ -n "$S3_BACKUP_BUCKET" ]; then
  echo "[Cloud Upload] Uploading snapshot to s3://${S3_BACKUP_BUCKET}/"
  aws s3 cp "$BACKUP_FILE" "s3://${S3_BACKUP_BUCKET}/" --quiet
  echo "[Success] Cloud backup completed successfully."
else
  echo "[Info] S3_BACKUP_BUCKET not configured. Local snapshot retained."
fi

# Cleanup old backups older than 14 days
find "$BACKUP_DIR" -type f -name "*.sql.gz" -mtime +14 -exec rm -f {} \;
echo "[Cleanup] Purged backups older than 14 days."
echo "=================================================="
