# Security Baseline

- Hub-issued SSO tokens are validated against issuer, audience and JWKS in production.
- `AUTH_MODE=dev` is explicitly rejected when `NODE_ENV=production`.
- Tenant context is checked against an active server-side membership; a tenant header never grants membership by itself.
- Server-side RBAC and location scope are checked for protected operations.
- MFA remains a Hub responsibility for privileged roles.
- Raw card data is not represented or stored by V79 Commerce.
- Until payment adapters are connected, non-cash payments/refunds require external provider references and remain auditable.
- Rate limiting, secure headers, request validation and restricted CORS are enabled in the API.
- Inventory/sale/receipt/transfer mutations use serializable transactions with retry on write conflicts.
- Immutable audit records cover refunds, purchase approvals, inventory adjustments, transfers and logistics events.
- Secrets belong in runtime environment/secret storage, never the repository.
- Production release still requires dependency/container scanning, baseline migration testing, restore testing, end-to-end tenant-isolation tests and payment-webhook signature verification.

## REDTEAM hardening — 2026-10-06

- Browser JavaScript syntax is now a CI/release gate; the public POS shell cannot silently ship truncated JavaScript.
- Workforce profile responses never return cashier PIN hashes or salts. PIN verification is rate-limited.
- Sales attributed to another cashier require a short-lived signed proof bound to tenant, location and employee.
- Register, order, inventory, stock-count, report, logistics and workforce reads are constrained to assigned locations for non-admin users.
- Non-owner users cannot change their own POS role/location scope. Managers cannot grant access outside their own locations or assign finance/audit/admin/owner roles.
- Team role/location changes are written to the audit log.
- Postgres and Redis run only on the private POS internal Docker network. The API is the only merchant-facing POS service on the reverse-proxy network.
- Integration webhook URLs are checked at configuration and delivery time; production delivery requires HTTPS and blocks private/reserved network targets.
- Direct CARD sales/order payments require a succeeded, unused, amount/currency-matched payment intent. Manual external terminal/bank/mobile workflows remain explicitly reference-based.
- Hub launch authentication is exchanged into an HttpOnly POS-local session with a configurable lifetime; active membership and location scope are still revalidated on every request.
- Hub and POS now support a dedicated POS platform secret. During migration the Hub can fall back to the legacy platform secret, but production should set a distinct Hub `V79_POS_PLATFORM_SHARED_SECRET` equal to POS `V79_PLATFORM_SHARED_SECRET`.

### Remaining launch security validation

- Run cross-tenant and cross-location negative integration tests against the deployed PostgreSQL stack.
- Validate real payment-provider/terminal adapters and webhook signatures in provider sandboxes before treating electronic tender as fully automated.
- Complete restore drills, dependency/container scanning and browser/device beta tests.
- Implement a guided allocation UI before exposing serialized, lot-tracked or expiry-controlled stock transfers to general users.
