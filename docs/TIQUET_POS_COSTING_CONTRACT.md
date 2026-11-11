# Tiquet–POS service-job costing: staged contract (11 November 2026)

**State: source-only calculation contract. NOT a live integration or production deployment.**

## Decision after comparing three approaches

1. Shared database writes: rejected. Would bypass product tenancy and source-of-truth ownership.
2. Synchronous direct calls on ticket updates: rejected as the sole mechanism. POS downtime could cause partial changes or repeated deductions.
3. **Transactional POS stock ledger + durable, signed, idempotent events + read-only verified cost snapshots: selected.** Only the calculation part of option 3 is introduced in this branch.

## Ownership and workflow

- **Hub** owns organisation and user identity, MFA, entitlements and signing/service authorisations.
- **Tiquet** owns ticket identity, workflow, approved time logs, customer approvals, invoices and revenue excluding tax. Its existing `jobs.timeLogs` is not automatically a verified labour-cost ledger.
- **POS** owns stock movements, location access, issued/returned quantities, FIFO cost layers, and final issue/return cost snapshots. Do not model service usage as retail sales or manual adjustments.
- **Accounting/FFPRO** owns cash receipts. Do not calculate revenue by adding receipts to an invoice; this double-counts sales.

## Intended event envelope (not implemented here)

Use a versioned envelope with `eventId`, `schemaVersion`, `source`, `tenantId`, `ticketId`, `occurredAt`, `correlationId`, `currency`, and signed payload. Events need a durable transactional outbox and consumer inbox with UNIQUE(tenantId, source, eventId). Sign with rotating service keys; verify body, timestamp, audience and endpoint before any mutation. Never accept tenant or actor identity from an unauthenticated browser body.

Material events:
- `ticket.material_reserved.v1` — POS reservation only; **no cost recognised yet**
- `ticket.material_issued.v1` — POS ledger debit, FIFO snapshot and ticket reference, one transaction
- `ticket.material_returned.v1` — POS ledger return; reverse cost against the original issued units, not current retail price
- `ticket.material_issue_failed.v1` — no changes to ledger if stock was insufficient

Labour events:
- `ticket.labour_approved.v1` — Tiquet time entry with immutable approved hours and internal cost rate snapshot
- `ticket.labour_reversed.v1` — reversing entry, not destructive edit

Revenue events:
- `ticket.invoice_finalised.v1` — Tiquet net invoiced revenue excluding tax, including verified credit notes
- `ticket.invoice_voided.v1` — reverse/correct revenue as appropriate, not a second invoice
- Customer cancellation does not silently release already issued physical stock; technician return is a separate controlled event.

## Calculation module in this branch

`packages/domain/src/ticket-costing.ts` computes a read-only snapshot in integer minor units:
- Deduplicates exact event retries and rejects reused IDs with different content
- Rejects cross-tenant, cross-ticket and cross-currency cost events
- Uses issued-minus-returned POS FIFO cost snapshots
- Includes only approved labour, rounding each time entry in minor units
- Includes explicit non-labour expenses
- Produces a profitability result **only** when revenue, materials, labour and other costs are independently marked reconciled
- Reports `INCOMPLETE` with reasons instead of showing an invented zero or margin
- Treats zero revenue as a possible loss with no margin percentage

**Trust boundary:** the pure function does not verify signatures, access privileges, source ownership or completeness of a true outbox/inbox. The API that gathers snapshots MUST do that before setting reconciliation flags.

## Pre-release /REDTEAM gates

- Tenant and location bypass; a technician must not issue from unauthorised locations.
- Retried delivery, concurrent issue, reversal races and conflicting event IDs.
- Stock negative/oversell, reserved-vs-issued consistency and FIFO row locking.
- Credit note, partial invoice, cancellation, refund and zero-revenue tickets.
- Changed hourly rates; approvals must snapshot the rate at approval time.
- One currency per ticket; conversions require explicit dated rates and audit.
- Missing/stale source or failed delivery: show `INCOMPLETE`, never "0 cost".
- No invoice email, POS sale or accounting credit issued merely because a costing event arrived.
- Backups, database migration and rollback rehearsals, Hub SSO/MFA, feature-flagged staging end-to-end and no production writes until accepted.

## Outstanding implementation (NOT complete)

1. Add dedicated service issue/return ledger types and database constraints in POS; durable idempotency key and cost snapshots.
2. Integrate technician stock check-out/return with POS location permissions.
3. Add signed and authenticated Hub-scoped event delivery and Tiquet consumer with tenant-safe inbox.
4. Add immutable approved labour-cost records and net invoiced revenue in Tiquet.
5. Build ticket reconciliation and margin view with source timestamps and drift/failure states.
6. Verify against actual running staging containers, tests, restore paths and release gates.
