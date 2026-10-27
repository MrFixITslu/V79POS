# Vision79 POS client workspace — 27 October 2026

Status: source candidate; not deployed, not merchant-release acceptance.

## Brainstorm and selected approach
1. Colours/logo only: leaves navigation overload and misleading dashboard states.
2. Selected: improve the existing frontend, preserve accepted checkout, stock-count and register reconciliation source, use shared Hub/Tiquet visual tokens.
3. Rebuild frontend: larger regression surface without a demonstrated need.

## Design
Light default with explicitly saved dark preference. Navy brand/navigation, blue primary actions, teal POS register symbol. Four dashboard metrics; stock signals have a separate strip. Navigation groups Sell & serve / Stock & supply and hides sections outside the current role's permissions. Focusable main and scrollable tables, 44px main controls, responsive register and dashboard. Unique register favicon, app icon and Vision79 POS logo (code-native SVG).

## Review findings / REDTEAM
- Main e4bf762 lacks accepted live hotfix. This branch inherits complete PR15 head 415947d, preserving stock-count envelope handling and server cash-variance display. That ancestry is source evidence, not fresh installed-image parity.
- Original dashboard coerced missing report amounts to zero and claimed LIVE / Operational without a service-health signal. Removed those claims; failed/missing report values show Unavailable with persistent retry warning.
- Read failures retain collection data internally but affected sections display Data unavailable and retry instead of old rows or misleading empty lists. Register dependencies failing to load suppress checkout controls. Reports show Unavailable instead of zero.
- Ten flat nav entries split into two groups; role filtering is presentation only and never replaces server enforcement.
- Financial calculations, auth/session exchange, tenant boundaries, worker, DB/schema, pricing and payment adapters are unchanged.
- PR15 historical reconciliation lookup may select an older session from recent sales. Preserved existing accepted behavior; latest-close guarantee is unverified and remains a client-release review item. No backend change is justified by this visual review alone.
- Test fixture uses sample data. Screenshots cannot prove real SSO, tenant isolation, balances, payment certification, receipt hardware or offline replay.

## Existing acceptance retained (not repeated)
Owner-reported live image 10200991 accepted reset, stock control and variance; prior sales/refunds accepted (PR15 record). Baseline migration and dedicated-key isolated SSO were previously passed. General CI on PR15 failed on registry HTTP429 after successful source checks; do not call that whole pipeline green.

## Verification for this change
Passed locally: browser JavaScript syntax, browser smoke script syntax and diff whitespace checks; seven existing loader/reconciliation tests (necessary because shared load/render code changed) and seven new full-source synthetic VM tests. New tests execute all ten actual view functions, permission-filtered navigation, failed/missing report fields versus true zero, saved appearance/cart retention, existing public asset allowlist, and failed section/register suppression.

Byte comparison against accepted PR15 source proves merchant views/modals, Hub session bootstrap and transaction submit handlers are unchanged. Backend, schema, domain, dependencies and runtime configuration are unchanged.

Prepared browser smoke covers all ten sections at 1440px/390px in light/dark with synthetic read-only APIs. It checks viewport overflow, runtime errors, restricted navigation, unavailable/malformed reports, stored appearance and direct-visitor shell. **NOT EXECUTED successfully:** Chromium is absent, and its download returned a truncated/non-ZIP response. No screenshots, visual/contrast pass or CI pass is claimed.

Read-through caught an asset delivery risk: production serves only /, /app.js, /app.css and /favicon.svg publicly. Candidate uses only those existing URLs, appends visual CSS to app.css, applies saved appearance in app.js and inlines the login SVG wordmark. Standalone pos-icon.svg / pos-logo.svg are reusable source assets, not new requested routes. Auth middleware/server are untouched. A saved dark preference applies when app.js runs; first-paint flicker still needs browser review.

The owner explicitly approved publishing the reviewed branch on 27 October 2026 after the public-source exposure was explained. Initial shell push lacked Git credentials; publication proceeds through the connected GitHub app. Source approval does not establish deployment or merchant-release acceptance. Remote inspection attempted once: Desktop Commander reports monthly usage exhausted; do not retry or infer runtime parity.

## Remaining client-release work
1. Review actual candidate screenshots, including touch checkout/cart and both themes.
2. Reconcile exact installed image, approved live overrides/config and frontend source before promotion. Preserve accepted runtime protections; do not deploy generic main.
3. Verify real candidate Hub launch/logout, tenant/location permissions and merchant workflows only where existing evidence does not cover the exact changed surface.
4. Confirm business-required receipt printer/scanner/cash drawer and offline limitations; provider-specific electronic payment adapters remain unverified. Manual/external terminal labels must describe actual functionality.
5. Resolve outstanding production security/concurrency/device gates from RELEASE_READINESS.md against current evidence; no broad retest or restore rehearsal solely for this UI work.

No production deployment, live payment, customer-data mutation, backup or rollback test performed for this candidate.
