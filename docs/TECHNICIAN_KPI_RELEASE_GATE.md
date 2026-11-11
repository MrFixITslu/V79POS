# V79 POS technician inventory + KPI reporting: release gate

Status: **draft PR #17, not merged or deployed**. Preserve existing POS application, icon, favicon, Hub MFA and data.

## Options and REDTEAM

Option A: deploy immediately (reject: backup and SSO proof missing). Option B: restore a production-derived backup in an isolated staging database, validate the new code and Hub contract, then approve a controlled cutover (**chosen**). Option C: build a parallel inventory service (reject: duplicate custody/ledger risks).

Never infer release readiness from build success or a healthy public website. Missing backup or entitlement evidence is a no-go.

## 1. Observe production without changing it

Run only from the authorised POS Docker host when remote connection is restored:

    hostname
    docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
    docker inspect v79-pos --format '{{.Image}}'
    docker inspect v79-pos-db --format '{{json .Mounts}}'
    docker exec v79-pos wget -qO- http://127.0.0.1:8080/ready

Record the currently deployed image digest, migration revision and recovery operator. Do not restart, pull, remove a volume or change DNS during this stage.

## 2. Back up production and verify an encrypted off-host copy

After confirming the host identity and database:

    umask 077
    export POS_BACKUP_DIR="$HOME/v79-pos-release-backups"
    mkdir -p "$POS_BACKUP_DIR"
    chmod 700 "$POS_BACKUP_DIR"
    export POS_BACKUP_FILE="$POS_BACKUP_DIR/v79commerce-$(date -u +%Y%m%dT%H%M%SZ).dump"
    docker exec v79-pos-db pg_dump -U v79commerce -d v79commerce --format=custom --no-owner --no-acl > "$POS_BACKUP_FILE"
    test -s "$POS_BACKUP_FILE"
    sha256sum "$POS_BACKUP_FILE" > "$POS_BACKUP_FILE.sha256"
    sha256sum -c "$POS_BACKUP_FILE.sha256"
    chmod 600 "$POS_BACKUP_FILE" "$POS_BACKUP_FILE.sha256"

Send the backup and checksum over the authorised encrypted off-host recovery channel. Verify both digests at the destination and record date, size and evidence receipt without exposing secrets or customer records. A local-only file is not sufficient evidence. Do not delete older recovery points.

## 3. Restore a true production copy to disposable PostgreSQL 17 on staging

On a separate authorised staging machine, use the private backup and checksum. The database name must start with v79pos_restore_, the server must be on loopback and the port cannot be 5432:

    export RESTORE_PASSWORD="$(openssl rand -hex 24)"
    podman run -d --rm --name v79pos-restore-drill \
      -e POSTGRES_USER=restoreqa \
      -e POSTGRES_PASSWORD="$RESTORE_PASSWORD" \
      -e POSTGRES_DB=v79pos_restore_release \
      -p 127.0.0.1:55479:5432 postgres:17
    export RESTORE_DATABASE_URL="postgresql://restoreqa:$RESTORE_PASSWORD@127.0.0.1:55479/v79pos_restore_release"
    export RESTORE_DRILL_CONFIRM=disposable-local-db
    export BACKUP_FILE="/secure/path/to/verified-backup.dump"
    sh scripts/restore-test.sh

After successful checksum and real restore, run the new migration only on the restored staging database:

    DATABASE_URL="$RESTORE_DATABASE_URL" pnpm db:deploy
    DATABASE_URL="$RESTORE_DATABASE_URL" pnpm db:validate

Verify migration state and counts of tenant, inventory balances, serials, lots, transfers and ledger against the backup snapshot. Record restore start/end, archive hash, data counts and migration result. Remove only the explicitly named staging container after evidence is saved; never use down -v on production. Unset temporary secrets.

## 4. Staging Hub security and customer acceptance

With real staging Hub authentication rather than local development auth:

- First Google login and MFA, subsequent Hub-to-POS launches, HttpOnly session, no secret in URL.
- Real signed Hub entitlement check enabled, denied expired plan, denied revoked member.
- Owner provisions technician and their dedicated MOBILE location, warehouse manager can dispatch, finance user can read reports, technician cannot read costs.
- Cross-tenant and cross-location data requests return denial; financial CSV cannot be fetched by technicians.
- Two warehouses receive standard, serialised and lot-controlled hardware; issue, install, good return, faulty quarantine, concurrency and audit trail reconcile.
- Android/iPhone layout, barcode input, network loss/retry, keyboard accessibility and zero-stock states.
- Week-on-week, month-on-month, year-on-year complete-period KPIs, CSV and print report, scoped correctly to selected warehouse.

Real Tiquet job validation and customer-recovered faulty hardware intake need specific acceptance evidence; an inventory-only test cannot establish that those integrations work.

## 5. Controlled release decision

Require: successful GitHub CI; signed off-host backup and completed restore drill; verified previous image digest; live staging Hub MFA/SSO and entitlements; cross-tenant checks; reconciled serial/lot stock; owner-reviewed deployment plan and recovery steps; **final explicit owner approval**.

Do not invoke deploy-prod.sh before the gate passes. After deployment, compare image digest, application readiness, Hub access, warehouse balances and KPI outputs.

Rollback of the application image does not automatically reverse a database migration. If data changes after cutover, reconcile them before any database restore. Never overwrite production database without a separately authorised recovery plan.

NO-GO: server access unavailable, unverifiable backup, missing restore witness, authentication or entitlement fault, wrong icon/version, or inventory differences.
