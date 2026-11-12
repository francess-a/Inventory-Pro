-- Restaurant inventory schema (PostgreSQL)
CREATE TABLE IF NOT EXISTS items (
    id                   SERIAL PRIMARY KEY,
    sku                  TEXT NOT NULL UNIQUE,
    name                 TEXT NOT NULL,
    category             TEXT NOT NULL DEFAULT '',
    store                TEXT NOT NULL DEFAULT 'Dry Store',
    unit                 TEXT NOT NULL DEFAULT '',
    unit_cost            NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
    opening_stock        NUMERIC(14,3) NOT NULL DEFAULT 0,
    manual_reorder_level NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (manual_reorder_level >= 0),
    active               BOOLEAN NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- IN = purchase / inbound
CREATE TABLE IF NOT EXISTS inbound (
    id         SERIAL PRIMARY KEY,
    date       DATE NOT NULL,
    item_id    INTEGER NOT NULL REFERENCES items(id),
    supplier   TEXT NOT NULL DEFAULT '',
    qty        NUMERIC(14,3) NOT NULL CHECK (qty > 0),
    unit_price NUMERIC(14,2) NOT NULL CHECK (unit_price >= 0),
    po_number  TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inbound_item_date ON inbound (item_id, date);
CREATE INDEX IF NOT EXISTS inbound_date ON inbound (date);

-- OUT = issue / consumption / outbound. unit_cost is the item's cost when it was issued.
CREATE TABLE IF NOT EXISTS outbound (
    id           SERIAL PRIMARY KEY,
    date         DATE NOT NULL,
    item_id      INTEGER NOT NULL REFERENCES items(id),
    department   TEXT NOT NULL,
    qty          NUMERIC(14,3) NOT NULL CHECK (qty > 0),
    unit_cost    NUMERIC(14,2) NOT NULL CHECK (unit_cost >= 0),
    requested_by TEXT NOT NULL DEFAULT '',
    reference    TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbound_item_date ON outbound (item_id, date);
CREATE INDEX IF NOT EXISTS outbound_date ON outbound (date);

CREATE TABLE IF NOT EXISTS sales (
    date           DATE PRIMARY KEY,
    food_sales     NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (food_sales >= 0),
    beverage_sales NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (beverage_sales >= 0),
    notes          TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS departments (
    name TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT INTO departments (name) VALUES
    ('Kitchen'), ('Bar'), ('Housekeeping'), ('Service'), ('Staff Meal'), ('Wastage')
ON CONFLICT DO NOTHING;

INSERT INTO settings (key, value) VALUES
    ('movement_period_days', '30'),
    ('lead_time_days', '2'),
    ('safety_stock_days', '2'),
    ('ordering_cost', '100'),
    ('holding_cost_pct', '20'),
    ('fast_moving_issues', '8'),
    ('target_food_cost_pct', '35')
ON CONFLICT DO NOTHING;
