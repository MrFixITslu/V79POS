# V79 Commerce API — Current Routes

All `/v1/*` routes require an authenticated Vision79 user and a verified tenant membership. Local development may use the explicit dev-auth headers documented in the README.

## Identity and team
- `GET /v1/me`
- `GET /v1/team`
- `POST /v1/team`

## Catalogue and customers
- `GET /v1/products`
- `POST /v1/products`
- `GET /v1/customers`
- `POST /v1/customers`

## POS sales
- `GET /v1/sales`
- `POST /v1/sales`
- `POST /v1/sales/:id/returns`

## Inventory
- `GET /v1/inventory`
- `POST /v1/inventory/adjustments`
- `GET /v1/transfers`
- `POST /v1/transfers`
- `POST /v1/transfers/:id/approve`
- `POST /v1/transfers/:id/dispatch`
- `POST /v1/transfers/:id/receive`

## Suppliers and purchasing
- `GET /v1/suppliers`
- `POST /v1/suppliers`
- `POST /v1/suppliers/:supplierId/products`
- `GET /v1/purchase-orders`
- `POST /v1/purchase-orders`
- `POST /v1/purchase-orders/:id/approve`
- `POST /v1/purchase-orders/:id/receive`

## Logistics
- `GET /v1/shipments`
- `POST /v1/shipments`
- `PATCH /v1/shipments/:id/status`

## Smart replenishment
- `GET /v1/replenishment`
- `PUT /v1/replenishment/policies`
- `POST /v1/replenishment/recalculate`
- `POST /v1/replenishment/create-draft-pos`
- `GET /v1/notifications`

## Service health
- `GET /health`
- `GET /ready`


## KPI Reports (read-only)

All endpoints require an authenticated Hub/POS session and the POS reporting permission.

- GET /v1/reports/trends?period=week|month|year&locationId=optional
- GET /v1/reports/trends.csv?period=week|month|year&locationId=optional

The responses are tenant/location scoped, use completed local calendar periods, include per-period KPI rows, change percentages with N/A for zero denominators, and a separately labelled current stock snapshot. CSV is downloadable. See docs/REPORTING.md.

## Technician mobile stock custody (draft PR #17)

- POST /v1/technician/assign — owner/admin creates or restores a technician MOBILE custody location
- GET /v1/technician/workspace — technician's actual stock, serials/lots, movements and usage
- POST /v1/technician/requests — issue / good return / faulty return request with unique requestKey
- POST /v1/technician/use — job-referenced consumption with unique requestKey
- POST /v1/transfers/:id/allocate — warehouse selects controlled serials/lots before dispatch
- GET /v1/transfers and approve/dispatch/receive — existing multi-stage warehouse/technician workflow
- POST /v1/locations — create a WAREHOUSE, STORE or OFFICE (owner/admin only)

The feature needs the additive technician migration and does not grant technicians warehouse-wide or finance permission. Production roll-out remains gated.
