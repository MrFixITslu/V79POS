#!/usr/bin/env bash
# Run on the Acer only. Never writes a plaintext PostgreSQL dump to disk.
set -Eeuo pipefail
umask 077
SERVER='firelion@100.73.248.30'
DIR="$HOME/v79-offhost-recovery/pos"
PREVIOUS="$DIR/v79-pos-prod-20261109T155642Z.dump.gpg"

[[ "$(hostname -s)" != "v79sl" ]] || { echo "Run on Acer, not server"; exit 1; }
[[ -s "$PREVIOUS" ]] || { echo "OFFHOST_BACKUP_BLOCKED=previous_encrypted_archive_missing"; exit 1; }
command -v gpg >/dev/null || { echo "OFFHOST_BACKUP_BLOCKED=gpg_missing"; exit 1; }
command -v ssh >/dev/null || { echo "OFFHOST_BACKUP_BLOCKED=ssh_missing"; exit 1; }

RECIPIENT="$(gpg --batch --no-tty --list-only --list-packets "$PREVIOUS" 2>/dev/null |
  sed -nE 's/.*keyid ([A-Fa-f0-9]{16}).*/\1/p' | head -n 1)"
[[ "$RECIPIENT" =~ ^[[:xdigit:]]{16}$ ]] ||
  { echo "OFFHOST_BACKUP_BLOCKED=cannot_identify_existing_backup_recipient"; exit 1; }
gpg --batch --list-keys "$RECIPIENT" >/dev/null 2>&1 ||
  { echo "OFFHOST_BACKUP_BLOCKED=existing_recipient_key_unavailable"; exit 1; }

mkdir -p "$DIR"
chmod 700 "$DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$DIR/v79-pos-prod-precutover-$STAMP.dump.gpg"
[[ ! -e "$DEST" ]] || { echo "OFFHOST_BACKUP_BLOCKED=destination_exists"; exit 1; }
DONE=0
cleanup() {
  if [[ "$DONE" != 1 ]]; then
    rm -f -- "$DEST" "$DEST.sha256"
  fi
}
trap cleanup EXIT

echo "CAPTURING_FRESH_ENCRYPTED_POS_BACKUP"
ssh -o BatchMode=yes -o ConnectTimeout=12 -T "$SERVER" \
  'set -e; test "$(docker inspect -f "{{.State.Health.Status}}" v79-pos-db)" = healthy; docker exec v79-pos-db pg_dump -U v79commerce -d v79commerce --format=custom --no-owner --no-acl' |
  gpg --batch --yes --trust-model always --recipient "$RECIPIENT" \
    --encrypt --output "$DEST"

[[ -s "$DEST" ]] || { echo "OFFHOST_BACKUP_BLOCKED=empty_encrypted_archive"; exit 1; }
sha256sum "$DEST" > "$DEST.sha256"
sha256sum -c "$DEST.sha256"

# Confirm genuine decryption, full streaming archive integrity and PG custom format.
gpg --batch --no-tty --quiet --decrypt "$DEST" |
  python3 -c 'import sys,shutil,os
stream=sys.stdin.buffer
if stream.read(5)!=b"PGDMP": raise SystemExit("invalid_postgres_archive")
with open(os.devnull,"wb") as sink: shutil.copyfileobj(stream,sink)
print("DECRYPTED_POSTGRES_ARCHIVE=PASS")'

BACKUP_SHA="$(sha256sum "$DEST" | awk '{print $1}')"
printf '%s\n' "$BACKUP_SHA" > "$HOME/.v79-pos-offhost-backup-sha"
chmod 600 "$HOME/.v79-pos-offhost-backup-sha"
DONE=1
echo "OFFHOST_ENCRYPTED_BACKUP=PASS"
echo "OFFHOST_BACKUP_SHA256=$BACKUP_SHA"
echo "OFFHOST_BACKUP_PATH=$DEST"
echo "PRODUCTION_DATABASE_UNCHANGED=YES"
