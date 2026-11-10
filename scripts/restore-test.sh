#!/usr/bin/env sh
# Restore backup into a deliberately named EMPTY, LOCAL test database only.
# This script must NEVER modify a production POS database.
set -eu
umask 077
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is required}"
: "${BACKUP_FILE:?BACKUP_FILE is required}"
[ "${RESTORE_DRILL_CONFIRM:-}" = "disposable-local-db" ] || {
  echo 'RESTORE_BLOCKED=explicit_disposable_database_confirmation_required' >&2; exit 2;
}
[ -s "$BACKUP_FILE" ] && [ -s "$BACKUP_FILE.sha256" ] || {
  echo 'RESTORE_BLOCKED=missing_backup_or_checksum' >&2; exit 2;
}
# Validate before any database connection or mutation.
# Restrict to loopback and a non-default port, AND a purpose-named DB.
python3 - "$RESTORE_DATABASE_URL" <<'PY'
from urllib.parse import urlsplit, unquote
import sys
url = urlsplit(sys.argv[1])
database = unquote(url.path.lstrip('/')).split('/')[0]
if (url.scheme not in ('postgres', 'postgresql') or
    url.hostname not in ('127.0.0.1', 'localhost', '::1') or
    not url.port or url.port == 5432 or
    not database.startswith('v79pos_restore_') or
    len(database) > 63 or not database.replace('_', '').isalnum()):
    sys.exit('RESTORE_BLOCKED=not_a_loopback_disposable_database')
PY
sha256sum -c "$BACKUP_FILE.sha256"
DATABASE_NAME="$(psql "$RESTORE_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c 'SELECT current_database();')"
case "$DATABASE_NAME" in
  v79pos_restore_*) : ;;
  *) echo 'RESTORE_BLOCKED=unexpected_database' >&2; exit 2 ;;
esac
TABLES="$(psql "$RESTORE_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c "SELECT COUNT(*) FROM pg_catalog.pg_tables WHERE schemaname='public';")"
[ "$TABLES" = "0" ] || {
  echo 'RESTORE_BLOCKED=target_database_not_empty' >&2; exit 2;
}
# No --clean: only a fresh, empty test DB is a permitted target.
pg_restore --exit-on-error --no-owner --no-acl --dbname="$RESTORE_DATABASE_URL" "$BACKUP_FILE"
psql "$RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'SELECT COUNT(*) AS tenants FROM "Tenant";'
psql "$RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'SELECT COUNT(*) AS ledger_rows FROM "InventoryLedger";'
echo 'POS_RESTORE_DRILL=PASS'
