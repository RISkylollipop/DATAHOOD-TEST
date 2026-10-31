#!/usr/bin/env bash
# ============================================================
#  Nightly MySQL backup. Only needed if the database lives on
#  this server; a managed host does this for you.
#
#  Install:
#      cp backup-db.sh /usr/local/bin/ && chmod 700 /usr/local/bin/backup-db.sh
#      crontab -e
#      15 2 * * * /usr/local/bin/backup-db.sh >> /var/log/datahood-backup.log 2>&1
#
#  A backup you have never restored is not a backup. Once a month,
#  restore the newest file into a scratch database and count the rows
#  in `users` and `transactions`. That is the whole test.
# ============================================================
set -euo pipefail

BACKUP_DIR=/var/backups/datahood
KEEP_DAYS=14

# Credentials come from the same root-only file the API uses, so there
# is exactly one place a rotated password has to be changed.
set -a; . /etc/datahood/api.env; set +a
: "${DB_NAME:?DB_NAME missing from /etc/datahood/api.env}"

install -d -m 700 "$BACKUP_DIR"
STAMP=$(date +%F-%H%M)
OUT="$BACKUP_DIR/$DB_NAME-$STAMP.sql.gz"

# --single-transaction takes a consistent snapshot without locking
# InnoDB tables, so wallet writes are not blocked while this runs.
# Password via env, never on the command line, where it would be
# visible to every user on the box in `ps`.
MYSQL_PWD="$DB_PASSWORD" mysqldump \
  --host="${DB_HOST:-127.0.0.1}" \
  --port="${DB_PORT:-3306}" \
  --user="$DB_USER" \
  --single-transaction \
  --routines \
  --triggers \
  --default-character-set=utf8mb4 \
  "$DB_NAME" | gzip -9 > "$OUT.tmp"

# Only become the real filename once complete, so a backup interrupted
# half-way is never mistaken for a good one.
mv "$OUT.tmp" "$OUT"
chmod 600 "$OUT"

# Refuse to keep an implausibly small dump: a gzipped empty error
# message is a few hundred bytes and would otherwise sit there looking
# like a backup until the day it is needed.
SIZE=$(stat -c%s "$OUT")
if [[ "$SIZE" -lt 10240 ]]; then
  echo "$(date -Is) FAILED: dump is only ${SIZE} bytes — check credentials" >&2
  mv "$OUT" "$OUT.suspect"
  exit 1
fi

find "$BACKUP_DIR" -name "$DB_NAME-*.sql.gz" -mtime "+$KEEP_DAYS" -delete
echo "$(date -Is) ok $OUT ($((SIZE / 1024)) KiB)"

# NOTE: this keeps backups on the SAME DISK as the database, which
# protects against "I dropped the wrong table" but not against losing
# the server. Copy them off-box too — rclone to any object store, or
# a scheduled pull from your own machine over SSH.
