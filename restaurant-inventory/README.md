# Restaurant Inventory

Day-to-day stock tracking for a restaurant, built from the *Store In and Out tracking* workbook.

- **Backend:** Python (Flask) and PostgreSQL
- **Front end:** server-rendered HTML5 and CSS, no JavaScript framework

**IN** means purchase / inbound. **OUT** means issue / consumption / outbound.

## Pages

| Page | What it does |
|---|---|
| Dashboard | Inventory value, low-stock alerts, purchases, consumption and revenue for the day and month, food and beverage cost %, store costing, top 20 actions, top 30 highest and lowest expenditure |
| Master Inventory | Every item with opening stock, total inbound and outbound, current stock, status, minimum and maximum stock, reorder point, EOQ, fast / slow / non-moving, consumption value and % |
| Inbound | Receive stock. Search for the item by name or SKU, enter quantity, price, supplier and PO number |
| Outbound | Issue stock to a department. Refuses to issue more than is in stock |
| Departments | Units issued, dispatches and value per department |
| Reports | Key figures, store costing, monthly and daily tables, top lists |
| Sales | Daily food and beverage sales, used for revenue and cost % |
| Settings | Lead time, safety stock, EOQ inputs, movement thresholds and the department list |

Dashboard, Reports and Departments take an "as of" date so a past day can be reviewed.

## Run with Docker

```bash
cp .env.example .env
```

Edit `.env`, then:

```bash
docker compose up --build -d
```

Open http://localhost:8000.

## Run without Docker

Needs Python 3.11+ and PostgreSQL.

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
export DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/inventory
export SECRET_KEY=a-long-random-string
python app.py
```

Tables are created on first start.

## Load your items from the workbook

```bash
python import_excel.py "path/to/Store_In_nad_Out_tracking.xlsx"
```

With Docker, copy the file into the container first:

```bash
docker compose cp "Store_In_nad_Out_tracking.xlsx" web:/tmp/store.xlsx
docker compose exec web python import_excel.py /tmp/store.xlsx
```

This reads the `Dry Store`, `BAR INVENTORY` and `HK` sheets. Each item's closing stock in the
workbook becomes its opening stock in the app, and items get SKUs such as `DRY-001`, `BAR-001`
and `HK-001`. Running it again refreshes names, units and costs without touching stock or
history; add `--reset-stock` to overwrite opening stock too.

The workbook itself is not stored in this repository (`*.xlsx` is ignored).

## How the numbers are worked out

| Figure | Formula |
|---|---|
| Current stock | opening stock + total inbound − total outbound |
| Average daily consumption | outbound quantity in the movement period ÷ days of data (capped at the period) |
| Minimum stock | average daily consumption × safety stock days |
| Reorder point | average daily consumption × lead time + minimum stock |
| EOQ | √(2 × yearly consumption × ordering cost ÷ (unit cost × holding cost %)) |
| Maximum stock | reorder point + EOQ |
| Reorder level | the larger of the item's own reorder level and the reorder point |
| Status | `Reorder` when current stock ≤ reorder level, otherwise `OK` |
| Movement | fast when issued at least N times in the period, slow when issued fewer, non-moving when not issued |
| Consumption value | quantity issued × the item's unit cost when it was issued |
| Food cost % | dry store consumption ÷ food sales |
| Beverage cost % | bar consumption ÷ beverage sales |
| Store costing | stock value per store and its share of the total |
| Expenditure | purchase value per item for the month |

## Password

Set `APP_PASSWORD` to require a password. Without it the app is open to anyone who can reach it,
so do not expose it to the internet unprotected.

## Tests

The tests need an empty PostgreSQL database they are allowed to wipe:

```bash
TEST_DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/inventory_test pytest
```
