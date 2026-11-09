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

**Critical branding/version difference:** The running production image has a customised POS UI, dark/light preference, favicon, 14 brand image assets and manifest that were absent from the current draft PR. A three-way merge was prepared in a **persistent Acer staging checkout**; that checkout preserved the exact production index and favicon, themed navigation and new features. This staging merge has not been confirmed pushed to GitHub because Acer remote access stopped responding during the final browser check. Do not deploy the older branch assets.

The previously verified branch Chrome checks cannot substitute for a fresh test of the newly merged production-branded UI. Live Hub MFA/SSO and entitlement revalidation are still unverified for the proposed new image.

**No production deployment, database migration or change to favicon has occurred.** Keep PR #17 as draft. Record staged UI/Hub evidence and obtain final owner approval before merge and deployment. The disposable test database cleanup remains pending remote access recovery; never remove an unidentified or production container.
