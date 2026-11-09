#!/usr/bin/env sh
# V79 POS logical backup. Non-destructive and private by default.
set -eu
umask 077
: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
OUT="$BACKUP_DIR/v79commerce-$STAMP.dump"
TMP="$OUT.partial.$$"
trap 'rm -f "$TMP"' EXIT HUP INT TERM
# A failing pg_dump must not leave a file that looks like a valid backup.
pg_dump --format=custom --no-owner --no-acl --dbname="$DATABASE_URL" --file="$TMP"
[ -s "$TMP" ] || { echo 'Backup is empty; refusing success' >&2; exit 1; }
mv "$TMP" "$OUT"
sha256sum "$OUT" > "$OUT.sha256"
chmod 600 "$OUT" "$OUT.sha256"
# Never silently purge recovery points. Off-host transfer, restore and
# retention verification must happen before a separate authorised prune.
printf 'POS_BACKUP_CREATED=%s\n' "$OUT"
printf 'POS_BACKUP_SHA256=%s\n' "$OUT.sha256"
