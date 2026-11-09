# V79 POS — KPI Reports & Analytics

**Status:** implemented on draft PR #17; not merged or deployed.

## For business users

Open **V79 Hub → POS → Reports**. This page requires the reporting permission (owners, admins, managers, supervisors, purchasing, finance and auditors). Technicians cannot access finance reports.

Choose **Week on week**, **Month on month** or **Year on year** and optionally restrict results to one of your authorised locations.

- **KPI cards:** latest complete period compared with the previous complete period.
- **Chart:** select a KPI for its historical trend.
- **Detailed table:** all real period metrics.
- **Download CSV:** exports the same report values.
- **Print / Save PDF:** browser print-friendly management report.
- **Current stock:** separately labelled live snapshot, never misrepresented as a past balance.

## Period conventions

Periods follow the organisation's time zone, normally America/St_Lucia. Weeks start Monday, months start on the first, and years on 1 January. Incomplete current periods are excluded from historical comparisons. Reports include twelve complete weeks, twelve complete months, or five complete years. Thus year-on-year compares the last two **finished** calendar years, rather than falsely comparing an incomplete current year against a full previous year. Current-year-to-date vs prior-year-to-date remains a separate enhancement.

A previous-period value of zero produces N/A for percentage change. Sample/demo figures are never included in live reports.

## Metric definitions

| KPI | Source and meaning |
|---|---|
| Net sales | Completed sale totals including tax less completed sale returns posted during the period |
| Completed sales | Count by completed sale timestamp, excluding voided sales |
| Refunds and returns | Value of completed sale returns posted during the period |
| Supplier stock received | Inventory ledger purchase receipt quantities |
| Technician issues | Quantity on technician issue transfers received in the period |
| Equipment used | Sum of technician stock use quantities linked to jobs |
| Jobs supported | Unique job references with recorded technician consumption, not all Tiquet tickets |
| Good returns | Quantity of good technician return transfers received |
| Faulty returns | Quantity of faulty technician return transfers received and quarantined |
| Stock losses / damage flags | Ledger loss, damage and expiry movement quantities, not necessarily financial write-offs |

Units retain four decimal places. Report currency uses the tenant's currency; stock snapshots display on-hand, available, quarantined, pending technician transfers and unresolved exceptions. Historic inventory valuation is not inferred from today's balances.

## Security and behaviour

All queries enforce the authenticated Hub user, reporting permission, tenant and authorised location scopes. A foreign location ID is rejected even when the requesting user is an owner. Technicians have no generic report access. CSV text is escaped against spreadsheet formulas. The API returns no-store responses for CSV. No successful data is simulated: when no records exist, the period values are zero with a clear description.

## Verified / release gates

- Isolated TypeScript build, tests, lint, Prisma validation and browser JavaScript syntax checks: PASS.
- Migration on a disposable PostgreSQL 17 database: PASS.
- Local disposable API smoke covering 59 requests for returns, issue, serials, revocation, concurrency, tenant boundaries, report data and CSV: PASS.
- Headless Chrome desktop reporting and mobile technician layout at 390px: PASS.
- Real Hub SSO, MFA, entitlement revocation, actual production database restore, independent security acceptance and physical Android/iOS beta: NOT VERIFIED.

Do not merge or deploy until the remaining production-specific checks pass, rollback is evidenced and the owner approves. Preserve the existing POS favicon, icons and production version.
