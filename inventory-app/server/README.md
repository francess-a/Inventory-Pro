# Hotel Central Store – Server

One Express + Prisma + PostgreSQL server that runs the whole application: the REST API under
`/api`, and the React web app (`../frontend`) served from the same port. It covers a hotel's
central warehouse:

- **Users and roles.** Sign-up and login, with roles for store staff, approvers and
  administrators.

- **Purchasing from multiple suppliers.** Purchase orders per vendor (draft → sent →
  partially received → received). Goods receipts handle short shipments and rejected
  quantities, and record the actual invoice price. **Direct purchase entry** creates and
  receives a bill in one step, for cash or market purchases.
- **Requisitions and issues.** Departments raise requisitions, which are approved, then issued
  from the central store. Each issue line records quantity, unit cost and value. Stock moves
  from central to the outlet, and every movement is written to the transaction log with the
  central closing balance.
- **Automatic stock levels.** On hand, on order, average daily usage, safety stock (minimum),
  reorder point, maximum stock and the quantity to order for every item, plus ABC/XYZ
  classification.
- **Vendor scorecards.** Actual vs promised lead time, on-time delivery, fill rate, quality
  acceptance, price vs market, and an overall score and grade.
- **Market price trends.** Price history per item from goods receipts, vendor quotes and
  market rates. Shows 7-day and 30-day change, our cost vs market, and the cheapest vendor.

The web app has pages for all of the above: Dashboard, Stock, Purchases, Requisitions,
Vendors, Market Prices and (for admins) Users.

## Calculations

| Quantity | Formula |
| --- | --- |
| Weighted average cost | `(onHand × oldCost + qtyReceived × invoicePrice) / (onHand + qtyReceived)`, updated on every receipt; issues are valued at it |
| Average daily usage `d`, std-dev `σd` | From issues to outlets and waste from the central store over the last `PLANNING_HISTORY_DAYS` (90) |
| Lead time `L`, std-dev `σL` | The preferred (or last-used) vendor's **actual** average sent → delivered time. Falls back to the vendor's promised lead time, then `DEFAULT_LEAD_TIME_DAYS` |
| Safety stock = minimum | `Z × √(L·σd² + d²·σL²)` with `Z = SERVICE_LEVEL_Z` (1.65 ≈ 95% service level) |
| Reorder point | `d × L + safety stock` |
| Maximum stock | `safety stock + d × (L + REVIEW_PERIOD_DAYS)` |
| Quantity to order | When `onHand + onOrder ≤ reorder point`: `max − (onHand + onOrder)`, rounded up to the item's pack size (`orderMultiple`) |
| ABC | Ranked by consumption value: top 80% of value = A, next 15% = B, rest = C |
| XYZ | Coefficient of variation of weekly demand: ≤ 0.5 = X, ≤ 1.0 = Y, otherwise Z |
| Vendor score | 30% on-time + 25% fill rate + 25% quality acceptance + 20% price score (100 at or below market, −2 points per 1% above) |

Items with `autoPlanning: false`, or with no usage history, keep their manually entered
minimum, reorder point and maximum. `POST /api/replenishment/recalculate` writes the computed
levels and ABC/XYZ classes back to the item master.

## About "real-time" market prices

No free public API provides real-time wholesale prices for hotel commodities such as
vegetables, meat, linen or spirits. Market rates therefore come from three places:

1. **Goods receipts**, recorded automatically: the price you actually paid.
2. **Manual entry**: vendor quotes, or rates from a market visit, via the Market Prices page
   or `POST /api/market/prices`.
3. **An external feed**: set `MARKET_FEED_URL` to any endpoint that returns
   `[{ "sku", "unitPrice", "market"?, "recordedAt"? }]`. The API polls it every
   `MARKET_FEED_INTERVAL_MINUTES`, and you can also trigger a sync with
   `POST /api/market/feed/sync`. Bulk uploads go to `POST /api/market/prices/import`.

## Running

**With Docker:** run `docker compose up --build` from the repository root. That starts
PostgreSQL and the app (one container, built from `../Dockerfile`) at http://localhost:5100.
Database migrations run automatically on start.

**Without Docker** (Node 22 and PostgreSQL):

```bash
cd inventory-app
npm run install:all                     # server + frontend dependencies
cp server/.env.example server/.env      # set DATABASE_URL and JWT_SECRET
npm run db:migrate                      # create / update tables
npm run db:seed                         # optional: demo hotel with ~200 days of history
npm run build                           # build the web app
npm start                               # app + API on http://localhost:5100
```

**First login:** the first account created through "Create account" becomes the
administrator. The demo seed instead creates `admin@hotel.example`,
`approver@hotel.example` and `staff@hotel.example`, with the password from `SEED_PASSWORD`
(default `ChangeMe123!`). Change these before real use. Set `ALLOW_SIGNUP=false` to stop
self-registration; admins can still add users on the Users page.

**Frontend development with hot reload:** run `npm run dev:server` and `npm run dev:web`
(from `inventory-app`). The React dev server on port 3000 proxies `/api` to the server.
The web app reads `REACT_APP_CURRENCY` (default `INR`).

## Tests

```bash
npm test                                                   # unit tests for the formulas
TEST_DATABASE_URL=postgresql://... npm test                # plus the end-to-end API test
```

The API test creates its own temporary Postgres schema in the given database and drops it
afterwards.

## API overview (all under `/api`)

| Area | Endpoints |
| --- | --- |
| Auth | `POST /auth/register`, `POST /auth/login`, `GET /auth/me` |
| Users (admin) | `GET/POST /users`, `PATCH /users/:id` |
| Items | `GET/POST /items`, `GET/PATCH /items/:id` |
| Departments | `GET/POST /departments` |
| Stock | `GET /stock/outlets`, `POST /stock/adjustments`, `POST /stock/waste`, `GET /transactions` |
| Vendors | `GET/POST /vendors`, `PATCH /vendors/:id`, `GET /vendors/scorecards`, `GET /vendors/:id/scorecard` |
| Purchasing | `GET/POST /purchase-orders`, `POST /purchase-orders/direct`, `GET /purchase-orders/:id`, `POST /purchase-orders/:id/{send,receive,cancel}` |
| Requisitions | `GET/POST /requisitions`, `GET /requisitions/:id`, `POST /requisitions/:id/{approve,reject,issue}` |
| Replenishment | `GET /replenishment[?onlyReorder=true]`, `POST /replenishment/recalculate`, `POST /replenishment/purchase-orders` |
| Market | `GET /market/comparison`, `GET /market/items/:id/trend`, `POST /market/prices`, `POST /market/prices/import`, `POST /market/feed/sync` |
| Reports | `GET /reports/dashboard`, `GET /reports/analytics?from=&to=`, `GET /reports/department-consumption?from=&to=`, `GET /reports/indent-vs-received?from=&to=&outletDepartmentId=&status=` |

## Roles

Each user has a role: `user` (department staff), `approver` (store manager) or `admin`. Only
admins can manage users (`GET/POST /users`, `PATCH /users/:id`).

| Action | `user` (staff) | `approver` | `admin` |
| --- | --- | --- | --- |
| Raise requisitions and follow their status | ✓ | ✓ | ✓ |
| Indent vs Received report | ✓ | ✓ | ✓ |
| Approve/reject and issue requisitions | | ✓ | ✓ |
| Purchasing: POs, goods receipts, direct purchases, close short | | ✓ | ✓ |
| Stock, waste, adjustments, items, vendors, departments, market prices | | ✓ | ✓ |
| Dashboard, Reports, replenishment, vendor scorecards | | ✓ | ✓ |
| Manage users | | | ✓ |

Staff see only Requisitions and Indent vs Received in the menu. The API enforces the same
rules with an allow-list for staff (requisitions, the item and department pickers and the
indent report) and returns 403 for anything else.

## Indent vs Received

`GET /reports/indent-vs-received?from=&to=&outletDepartmentId=&status=` compares what
departments requested with what the store issued, for requisitions raised in the period. Each
line ends up received in full, received short, rejected, or still waiting. Fill rate is received
value ÷ indented value over closed lines (issued or rejected), so requisitions still waiting
don't lower it. The response has totals, a per-department and per-item breakdown, a weekly
series, and the individual lines.

## Quantities

All quantities are `Decimal(12, 3)`, so weighed and measured goods can be recorded exactly
(for example 2.5 kg, or 0.75 ltr). Pack sizes (`orderMultiple`) can also be fractional, such as
0.5 kg, and suggested order quantities are rounded up to them. Computed safety stock, reorder
point and maximum are rounded up to whole units.

## Known limitations

- Stock issued to an outlet is treated as consumed by that department: the expense is booked
  at issue. Outlet stock balances are tracked, but outlet-level consumption and closing counts
  are not.
- Market prices are only as current as the receipts, quotes and feed you provide (see above).
