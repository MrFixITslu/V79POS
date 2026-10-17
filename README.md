# V79 Commerce

**Smart POS, Inventory & Supply Chain for the Vision79 ecosystem.**

V79 Commerce is a multi-tenant commerce operating system: V79 POS at the register, backed by inventory, purchasing, supplier management, logistics, predictive replenishment, customers, fulfilment, workforce controls and integration events for Vision79 Hub, FFPRO2 and V79Marketing.

## Beta workspace

The TypeScript/Fastify service now serves a responsive browser interface from the same origin as the API. Its beta screens cover checkout, register sessions, catalogue, inventory, customers, sales history, supplier product links, purchase orders, stock receiving and reorder policies. The read-only demo uses labelled sample data. Live mutations still require a verified Hub POS JWT and an active tenant membership. Advanced API features such as split tenders, refunds, lot/serial sales and offline sync still need dedicated UI and device beta testing.

### Implemented

- Strict multi-tenant membership, roles, permissions and location access
- Vision79 Hub JWT/JWKS auth foundation; development auth disabled in production
- Product catalogue, SKUs, barcodes, variants, services, serial/lot/expiry tracking
- Immutable inventory ledger and cached location balances
- FIFO inventory costing, COGS and cost-preserving branch transfers
- Full/cycle/blind stock counts with approval and variance movements
- Multi-location transfers, reservations and inventory exceptions
- POS sales, discounts, taxes, split tenders, change, returns and refunds
- Cash register sessions, opening float, paid-in/out, cash drops/pickups and reconciliation
- Customer price lists, scheduled promotions and promotion codes
- Store credit, hashed gift cards and loyalty ledgers
- Quotes, orders, invoices, layaway, deposits and partial payments
- Customer fulfilment: pickup, local delivery, shipment, dispatch and proof metadata
- Supplier/vendor management, purchase orders, approvals and partial receiving
- Landed-cost allocation, inbound shipments and logistics exception tracking
- Smart replenishment using velocity, safety stock, supplier history and dated inbound receipts
- Projected stock-out date, safety-stock breach date and must-order-by date
- MOQ/case-pack-aware recommended order quantities and draft-PO generation
- Expiry-risk notifications for stock approaching or past expiry
- Workforce profiles, cashier PIN verification, shifts and commissions
- Offline POS bootstrap/snapshot/replay foundation with idempotent sale sync
- Tenant-scoped payment-provider connection/intents/webhook boundary without raw card storage
- Transactional outbox with signed/retried delivery to Hub, FFPRO2, V79Marketing/custom endpoints
- Owner KPI dashboard, margin/inventory/supplier/logistics reports and deterministic intelligence briefing
- Immutable audit records, retention cleanup, backup and restore-test scripts
- Docker development stack, production compose template and CI validation pipeline

## Local development

```bash
cp .env.example .env
# Change local secrets and POSTGRES_PASSWORD.
docker compose -f docker-compose.dev.yml up --build -d
```

For local development use `docker-compose.dev.yml`. The default `docker-compose.yml` is the production stack and applies the checked-in migrations. Bootstrap a development tenant/location/register:

```bash
docker compose -f docker-compose.dev.yml exec api node apps/api/dist/scripts/bootstrap.js
```

Health:

```text
GET /health
GET /ready
```

## P2 safety gate for POS rollout (draft)

The `scripts/deploy-prod.sh` candidate now checks the **effective rendered Compose configuration before any Docker mutation**. It requires production Hub authentication, `V79_ENTITLEMENT_RECHECK_ENABLED=1`, a production POS origin, a usable Hub URL/JWKS and a sufficiently strong configured service secret. The database must remain only on an internal Docker network. It prints only generic denial codes, never secrets.

The checked-in `.env.production.example` intentionally retains entitlement rechecks disabled until Hub signed entitlement endpoint compatibility is proven; therefore a direct production deploy with unchanged example settings is **blocked**. This is intentional, not an instruction to flip it without testing. Confirm the installed Hub supports `/api/platform/entitlement/check`, run a private two-tenant/expiry test, validate database backup and immutable rollback, then explicitly set the value and re-run the preflight.

Run isolated syntax/config tests with `node scripts/pos-release-preflight.test.mjs`. This check does **not** prove device, payments, real network connectivity, independent security signoff, or actual live deployment.

## Production deployment

Production uses the checked-in Prisma baseline migration, validated against a fresh PostgreSQL 17 database in CI. It does not use `db push`.

```bash
cp .env.production.example .env
# Set the secrets and Hub configuration in .env.
./scripts/deploy-prod.sh
```

For an existing database volume returning Prisma P1000, follow `docs/DEPLOYMENT.md` and run `./scripts/repair-server.sh`. See `docs/RELEASE_READINESS.md` for validation evidence.

## Verification commands

```bash
pnpm install
pnpm db:generate
pnpm db:validate
pnpm build
pnpm test
pnpm lint
```

CI runs these commands on pushes/PRs. A release should not be deployed if any gate fails.

## External configuration still required before a live merchant launch

These are deployment/integration inputs, not missing domain architecture:

- Vision79 Hub production issuer/audience and the same `V79_PLATFORM_SHARED_SECRET` used by Hub. Configure POS `HUB_INTERNAL_URL=http://v79-hub:3040`, `HUB_JWKS_URL=http://v79-hub:3040/.well-known/jwks.json`, and `POS_PUBLIC_URL=https://pos.v79sl.com` on `proxy_network`. In Hub set `POS_BASE_URL=http://v79-commerce-api:8080` and `POS_PUBLIC_URL=https://pos.v79sl.com`. The owner opens POS from Hub; POS exchanges the one-time ticket server to server and sets a five-minute HttpOnly session cookie. Relaunch from Hub when it expires.
- Actual WiPay/Stripe/card-terminal provider credentials and provider-specific adapter implementation/testing
- FFPRO2/V79Marketing/Hub endpoint URLs and shared webhook secrets
- SMTP/SMS/push provider configuration if those delivery channels are enabled
- End-to-end device/payment beta testing

See `docs/IMPLEMENTATION_STATUS.md`, `docs/API.md`, `docs/SECURITY.md` and `docs/RELEASE_READINESS.md`.
