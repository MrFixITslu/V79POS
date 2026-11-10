# V79 POS: production-derived restore and migration rehearsal

**Date:** 9 November 2026. **Status:** restore and additive migration PASS; production release still NO-GO.

## Live source (read-only)

- POS image in production: `localhost/v79-brand-pos:20261106-r1`.
- Recorded running image ID: `sha256:7103df9054b3433217d01f44f8495336b4ed8b55314217db9cb1167e98a186b6`.
- Existing production database: PostgreSQL 17, approximately 12 MB, one completed migration (`20260925_baseline`).
- The production server's containers and original volume were not changed.

## Fresh encrypted backup

- Archive timestamp: `20261109T155642Z`.
- `pg_dump` from the production POS PostgreSQL container was streamed over authenticated Tailscale SSH directly to GPG encryption on the **separate Acer computer**.
- Existing Vision79 GPG recovery public key used; no plaintext database dump was written to the Acer disk by this process.
- GPG encrypted file was saved privately under the Acer's `v79-offhost-recovery/pos` directory with a SHA-256 checksum companion.
- The encrypted file checksum was verified, and decryption piped through `pg_restore --list` successfully parsed a PostgreSQL custom archive.

## Restore test on Acer

- Target: disposable PostgreSQL 17 in a Podman container, accessible only at `127.0.0.1:55479`, database `v79pos_restore_release`. This is not a production volume or network.
- The encrypted dump was streamed directly from GPG decryption into `pg_restore --single-transaction --exit-on-error --no-owner --no-acl`.
- `PRODUCTION_COPY_RESTORE_PASS` was observed.
- Independently checked record counts on production and on the restored copy, before the migration:

| Table / measure | Production | Restored |
|---|---:|---:|
| Tenant | 2 | 2 |
| InventoryLedger | 3 | 3 |
| InventoryBalance | 1 | 1 |
| InventorySerial | 0 | 0 |
| InventoryLot | 0 | 0 |
| StockTransfer | 0 | 0 |
| _prisma_migrations | 1 | 1 |

- Applied checked-in additive migration `20261109140000_technician_stock` **only to the restored test database**. Prisma reported success.
- After migration: 2 migration records, new `TechnicianUsage` table present; listed original record counts unchanged.
- Generated client, Prisma schema checks, TypeScript build, automated unit tests, lint and browser JavaScript syntax passed against the branded staging checkout.
- A disposable dev-auth tenant on the migrated restored database passed **63** stock, tenant-security, serialisation, revocation, concurrent-use, trend KPI and CSV integration requests.

## Version and release safeguards

The running production image `localhost/v79-brand-pos:20261106-r1` contained a newer customised frontend than the original feature branch. A controlled three-way merge preserved the production `index.html`, approved `favicon.svg`, 14 branded images, app manifest, styling and light/dark preference while adding new technician and reporting features. This merge was **pushed to PR #17** in commit `b228699`; the expanded browser checks were pushed as `f884057`.

Verification on the Acer staging branch:
- Google Chrome with authenticated *development* test membership: production favicon, logo, manifest and functional light/dark toggle **PASS**.
- Report navigation, 10 KPI cards, 12 completed periods, CSV control and methodology **PASS**.
- Technician viewport 390px, actual live stock and request forms without horizontal overflow **PASS**.
- GitHub CI #200 and #201 **PASS**. Extra regression checks now guard the favicon and branding in CI.
- Live POS service: `AUTH_MODE=hub` and `V79_ENTITLEMENT_RECHECK_ENABLED=1`. The running POS's internal Hub endpoint returned HTTP 401 to unsigned requests and HTTP 200 with `allowed:false` for a correctly signed nonexistent membership. This confirms the signed API contract and fail-closed denial of that test case, **not** a real positive login/MFA entitlement.
- The disposable Acer staging API and restored PostgreSQL 17 container were stopped after testing. No listener remains on test ports 18080 or 55479. The encrypted off-host backup and checksum remain preserved and were reverified.

**Still unverified:** a real customer/user first Google login/MFA and Hub SSO launch with the proposed image, active subscription positive and expired subscription negative entitlement, physical handset testing, Tiquet real-job validation and recovery/RMA for hardware already installed at customers. Do not claim that these passed on the basis of local dev-auth testing.

**No production deployment, database migration or favicon change has occurred.** Keep PR #17 as draft and obtain final approval only after the remaining release gates pass. The database backup proves recovery of the POS data, but a container image rollback alone does not roll back a database migration.
