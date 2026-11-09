# Private V79 POS / Hub integration staging — 9 November 2026

**Status: staging image, isolated PostgreSQL/Redis, encrypted-backup restore and technician migration confirmed from the owner's terminal output on 9 November 2026. Staging API and Hub SSO are NOT yet verified.** Production POS image remains unchanged and healthy in the user's latest check.

## Alternatives and REDTEAM

1. **Acer-only integration:** isolated but lacks direct access to the Hub internal signing service and cannot reliably reproduce real Hub network/session paths.
2. **Private, uniquely named server-side staging on a separate database:** **selected**. Run the candidate POS API beside the production Hub on the existing proxy network, while isolating its database and Redis on a private Docker network.
3. **Live production canary:** rejected because an unverified auth failure or wrong volume could interrupt existing customers.

Risks to prevent: staging accidentally connecting to the live POS DB, exposing customer data publicly, sending real outbound communications, using a development bypass of Hub auth, and replacing the live POS image or favicon. Use a private loopback port, no staging worker, separate database/Redis and unique image/Compose names. The staging app uses `AUTH_MODE=hub` and `V79_ENTITLEMENT_RECHECK_ENABLED=1` with the existing signed Hub endpoint. The localhost HTTP preview uses `NODE_ENV=development` only to allow its local loopback cookie; **this cannot certify production Secure-cookie behaviour**.

## Verified preparation

- Server checkout: `/home/firelion/v79-pos-hubqa-20261109/source`, pinned to PR #17 commit `25906235cb59e6fe89f41fbfc2f298a55ca9da45`.
- Private staging directory: `/home/firelion/v79-pos-hubqa-20261109/`.
- `hubqa.compose.yml` and `prepare-stage-env.py` copied to this directory.
- `.env` prepared, restricted to mode 0600; contains unique staging DB and encryption keys, with only the minimum existing Hub service-signing credentials copied locally on the server. **Do not print or publish `.env`.**
- Docker Compose validation returned `HUBQA_COMPOSE_VALID=PASS`.
- Proposed private containers: `v79-pos-hubqa-db`, `v79-pos-hubqa-redis`, `v79-pos-hubqa-api`.
- Isolated volume: `v79pos_hubqa_20261109_db`, network `v79pos-hubqa-20261109_stage_internal`; database and Redis have no host-published ports.
- Staging API alone binds `127.0.0.1:18081` on the server, with Hub access through existing `proxy_network`; no public DNS or Nginx Proxy Manager host was created.
- Stage image build was started using low-priority `ionice -c3 nice -n 10 docker build --progress=plain -t v79pos:hubqa-2590623 .` in the *isolated checkout*, logging to `/home/firelion/v79-pos-hubqa-20261109/build.log`. **Its final result was not observed**.
- Production POS was still `localhost/v79-brand-pos:20261106-r1`, **healthy**, on the last verified check.

## Owner-confirmed staging milestones (9 November 2026)

The owner ran the verification and restore commands from the Acer and supplied the complete success output:

- Stage image `v79pos:hubqa-2590623` exists (image ID `sha256:9a1abea699f8f750feb21b2f53e5973389442a6be1ba945293913af973bf2433`).
- The named isolated PostgreSQL 17 and Redis containers became healthy.
- Before restoration, `STAGING_TABLES=0` was observed.
- Encrypted archive checksum `OK` and `EMPTY_STAGING_DATABASE=PASS` were observed.
- `STAGING_RESTORE=PASS` was observed from `pg_restore --single-transaction --exit-on-error` against the *stage-only* `v79pos_hubqa` database.
- Staged Prisma migration `20261109140000_technician_stock` reported success, with `STAGING_MIGRATION=PASS` and the count result `2|3|2` (tenant count, inventory ledger count, migration count).
- Production image still `localhost/v79-brand-pos:20261106-r1`, `STATUS=healthy`.

**Next:** start `api` only from this named Compose file; check `/ready` is HTTP 200, public branding assets load, unauthenticated `/v1/me` is 401 and that the published port is loopback-only. Then perform controlled owner-only Hub SSO and access tests. The private stage has production-derived data; do not expose it publicly.

## Historical preparation and restore procedure (already completed)

On the production server (or via authenticated Tailscale SSH), start with **read-only verification**:

```sh
cd /home/firelion/v79-pos-hubqa-20261109
docker image inspect v79pos:hubqa-2590623 --format '{{.Id}}' || true
tail -30 build.log
docker compose --env-file .env -f hubqa.compose.yml config --quiet
docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep -E '^v79-pos(-hubqa|-db| )' || true
```

If the stage image build completed successfully and `docker image inspect` confirms the **unique** tag, and ONLY if the stage DB is absent/empty, start *only* the separate database and cache:

```sh
cd /home/firelion/v79-pos-hubqa-20261109
docker compose --env-file .env -f hubqa.compose.yml up -d db cache
docker exec v79-pos-hubqa-db psql -X -U v79commerce -d v79pos_hubqa -Atc "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='public';"
```

The output must be `0` before restoring a production-derived snapshot. If it is not empty, **stop and inspect**; never restore over it blindly. Use the existing checksum-verified encrypted off-host backup on the Acer, not a new destructive production operation:

```sh
# On the Acer laptop only:
set -o pipefail
archive="$HOME/v79-offhost-recovery/pos/v79-pos-prod-20261109T155642Z.dump.gpg"
sha256sum -c "$archive.sha256"
gpg --batch --quiet --decrypt "$archive" |
  ssh -o StrictHostKeyChecking=yes firelion@100.73.248.30 \
    'docker exec -i v79-pos-hubqa-db pg_restore --single-transaction --exit-on-error --no-owner --no-acl -U v79commerce -d v79pos_hubqa'
```

After successful restore, run **only the staged** migration and API (server terminal):

```sh
cd /home/firelion/v79-pos-hubqa-20261109
docker compose --env-file .env -f hubqa.compose.yml run --rm --no-deps api ./node_modules/.bin/prisma migrate deploy
docker compose --env-file .env -f hubqa.compose.yml up -d api
docker exec v79-pos-hubqa-api wget -qO- http://127.0.0.1:8080/ready
curl -si http://127.0.0.1:18081/v1/me | head -12
```

The unauthenticated read must return **401**. Compare image tags, container IDs and database names against live production. Do not run `docker compose down -v` or restart live POS/Hub.

For private browser inspection from the Acer, use a separate terminal with:

```sh
ssh -N -L 18081:127.0.0.1:18081 firelion@100.73.248.30
```

Then open `http://127.0.0.1:18081` from the Acer. **This is a private staging preview, not a live customer login link.** The production Hub currently issues POS launch tickets for `https://pos.v79sl.com`; it does not automatically redirect to this loopback instance. A controlled owner-only staging launch path must be reviewed and tested before claiming end-to-end Hub SSO or MFA compatibility. Do not paste session tokens or disable subscription checks.

## Still needed before authorising production POS

Verify true Hub login, Google OAuth/MFA, membership provisioning, active and expired entitlement, token revocation, Android/iPhone touch and scanner tests, Tiquet job validation, installed-device recovery intake, dependency/security review and an approved rollback plan. The existing encrypted POS backup, completed off-host restore rehearsal, staging migration test, 63-request API suite, desktop/mobile Chrome checks and GitHub CI #203 remain valid. **No production deployment is authorised by this document.**
