# V79 Commerce release readiness

Status: **Backend release candidate 1.0.0-rc.1**

## Code-complete backend scope

The release candidate contains the commerce domain required for a modern multi-location POS: sales/refunds, register sessions, inventory ledger and costing, stock counts, price lists/promotions, internal value, commercial orders/deposits, suppliers/POs/receiving, logistics, replenishment, fulfilment, workforce, offline sync foundations, reports, audit and ecosystem delivery.

## Release gates

Completed in GitHub CI / verified baseline workflow:

1. ✅ Locked project dependencies install successfully and `pnpm-lock.yaml` is committed.
2. ✅ `pnpm db:generate` and `pnpm db:validate` pass.
3. ✅ A Prisma baseline migration is committed.
4. ✅ The baseline migration deploys successfully to a fresh PostgreSQL 17 database.
5. ✅ `pnpm build`, `pnpm test` and `pnpm lint` pass.

Remaining before merchant production launch:

6. Run broader integration/concurrency tests against PostgreSQL, including simultaneous inventory sale/transfer scenarios.
7. Configure Hub production authentication and verify tenant isolation with cross-tenant negative tests.
8. Configure and test actual payment adapters/terminal webhooks with provider sandboxes. V79 Commerce must never receive/store raw PAN/CVV.
9. Configure and test FFPRO2, V79Marketing and Hub webhook consumers with idempotency/retry tests.
10. Complete UI/offline-device beta testing, accessibility, load/performance and restore drills before merchant launch.

## Current external blockers

The backend dependency, Prisma validation and baseline-migration blockers have been removed using GitHub-hosted validation. The generated baseline was deployed successfully against a fresh PostgreSQL 17 service before it was committed.

The connected Figma Starter account reached its MCP tool-call allowance; UI design remains intentionally deferred until access resets. Live payment and ecosystem-provider validation also require their sandbox/production credentials and endpoints.

## Safety/financial invariants implemented

- Stock quantities are derived from immutable movements; adjustments append compensating entries.
- FIFO cost layers are separate from quantity movements and feed COGS/gross-margin reporting.
- Sales, stock movements, payments, internal-value debits/refunds and outbox records are transactional.
- Internal-value refunds credit their corresponding ledgers rather than only writing a refund row.
- Cash reconciliation includes cash POS payments and cash deposits on commercial orders linked to the register session.
- Expired lots are blocked from sale and from sellable-stock restocking.
- Offline sale replay is idempotent; oversells become explicit inventory exceptions.
- Machine webhooks are authenticated by signatures and do not depend on interactive Hub login.
- Production configuration rejects development auth/default cryptographic secrets.

## REDTEAM remediation update — 2026-10-06

Completed after the original RC review:

- ✅ Restored the complete merchant browser application after a redesign commit truncated `app.js`.
- ✅ Added browser syntax validation to CI and the release-check script.
- ✅ Removed cashier PIN material from API responses and bound employee attribution to recent PIN verification.
- ✅ Closed identified location-scope leaks across registers, orders, inventory, reports, stock counts, logistics and workforce views.
- ✅ Prevented manager self-escalation and out-of-scope location/role assignment.
- ✅ Isolated Postgres/Redis from the shared proxy network.
- ✅ Added outbound webhook SSRF controls.
- ✅ Replaced the five-minute Hub-token browser lifetime with an 8-hour configurable POS session while retaining live membership checks.
- ✅ Direct CARD tender now requires a succeeded payment intent.
- ✅ Added merchant returns/refunds, quotes/orders/invoices/layaway, cycle counts and standard branch-transfer workflows to the browser UI.
- ✅ Current CI/release checks include locked dependencies, Prisma validation, browser JavaScript syntax, TypeScript build, tests, lint and production Compose boot.

Still required before unrestricted merchant production:

- Provider-specific electronic payment sandbox certification.
- Deployed end-to-end tenant/location isolation tests and realistic concurrency/load tests.
- Real device/offline beta validation, including outage/reconnect/replay behavior.
- Guided UI for lot/serial/expiry transfer allocation plus broader admin surfaces (loyalty, gift cards, fulfillment, workforce and integration administration) as product scope requires.
- Production backup restore drill and dependency/container security scan.
