"""Stock levels, movement classes and report figures.

IN  = purchase / inbound.   OUT = issue / consumption / outbound.
Everything is worked out as of a chosen date so past days can be reviewed.
"""
from datetime import date, timedelta
from math import sqrt

STORES = ["Dry Store", "Bar", "Housekeeping"]

SETTING_DEFAULTS = {
    "movement_period_days": 30,
    "lead_time_days": 2,
    "safety_stock_days": 2,
    "ordering_cost": 100,
    "holding_cost_pct": 20,
    "fast_moving_issues": 8,
    "target_food_cost_pct": 35,
}

SETTING_LABELS = {
    "movement_period_days": ("Movement period (days)", "Recent days of outbound used for average consumption and fast / slow / non-moving."),
    "lead_time_days": ("Lead time (days)", "Days between placing an order and receiving it."),
    "safety_stock_days": ("Safety stock (days)", "Days of consumption kept as a buffer. Sets minimum stock."),
    "ordering_cost": ("Ordering cost per order", "Cost of placing one purchase order. Used for EOQ."),
    "holding_cost_pct": ("Holding cost per year (%)", "Yearly cost of holding stock, as a percentage of its value. Used for EOQ."),
    "fast_moving_issues": ("Fast-moving: issues in period", "Issued at least this many times in the period = fast moving; fewer = slow; none = non-moving."),
    "target_food_cost_pct": ("Target food cost (%)", "Reports flag the month when food cost % goes above this."),
}

ACTIONS = {
    1: "Out of stock, no recent issues - restock only if still needed",
    2: "Non-moving - stop buying; use up, promote or return",
    3: "Overstocked - pause purchases until stock falls below maximum",
}


def load_settings(conn) -> dict:
    out = dict(SETTING_DEFAULTS)
    for row in conn.execute("SELECT key, value FROM settings"):
        if row["key"] in out:
            try:
                out[row["key"]] = float(row["value"])
            except ValueError:
                pass
    return out


def month_bounds(d: date) -> tuple[date, date]:
    first = d.replace(day=1)
    nxt = (first + timedelta(days=32)).replace(day=1)
    return first, nxt


def pct(part, whole):
    """Share as a percentage, or None when there is nothing to divide by."""
    if not whole:
        return None
    return float(part) / float(whole) * 100


ITEM_SQL = """
SELECT i.id, i.sku, i.name, i.category, i.store, i.unit, i.unit_cost, i.opening_stock,
       i.manual_reorder_level,
       COALESCE(n.total_in, 0)            AS total_in,
       COALESCE(n.month_purchase, 0)      AS month_purchase_value,
       COALESCE(o.total_out, 0)           AS total_out,
       COALESCE(o.period_qty, 0)          AS period_qty,
       COALESCE(o.period_issues, 0)       AS period_issues,
       COALESCE(o.month_qty, 0)           AS month_qty,
       COALESCE(o.month_value, 0)         AS month_value
FROM items i
LEFT JOIN (
    SELECT item_id,
           SUM(qty) AS total_in,
           SUM(qty * unit_price) FILTER (WHERE date >= %(m0)s) AS month_purchase
    FROM inbound WHERE date <= %(as_of)s GROUP BY item_id
) n ON n.item_id = i.id
LEFT JOIN (
    SELECT item_id,
           SUM(qty) AS total_out,
           SUM(qty) FILTER (WHERE date > %(p0)s)  AS period_qty,
           COUNT(*) FILTER (WHERE date > %(p0)s)  AS period_issues,
           SUM(qty) FILTER (WHERE date >= %(m0)s) AS month_qty,
           SUM(qty * unit_cost) FILTER (WHERE date >= %(m0)s) AS month_value
    FROM outbound WHERE date <= %(as_of)s GROUP BY item_id
) o ON o.item_id = i.id
WHERE i.active
ORDER BY CASE i.store WHEN 'Dry Store' THEN 1 WHEN 'Bar' THEN 2 WHEN 'Housekeeping' THEN 3 ELSE 4 END, i.sku
"""


def days_of_data(conn, as_of: date, period: int) -> int:
    """Days of outbound history to average over, capped at the movement period."""
    first = conn.execute("SELECT MIN(date) AS d FROM outbound WHERE date <= %s", (as_of,)).fetchone()["d"]
    if first is None:
        return 1
    return max(1, min(period, (as_of - first).days + 1))


def inventory(conn, as_of: date, settings: dict | None = None) -> list[dict]:
    """Every active item with stock levels, movement class and suggested action."""
    s = settings or load_settings(conn)
    period = int(s["movement_period_days"])
    m0, _ = month_bounds(as_of)
    rows = conn.execute(ITEM_SQL, {"as_of": as_of, "m0": m0, "p0": as_of - timedelta(days=period)}).fetchall()
    days = days_of_data(conn, as_of, period)
    hold = s["holding_cost_pct"] / 100
    total_month_value = sum(r["month_value"] for r in rows)

    names: dict[str, int] = {}
    for r in rows:
        names[r["name"].strip().lower()] = names.get(r["name"].strip().lower(), 0) + 1

    for r in rows:
        cost = float(r["unit_cost"])
        current = float(r["opening_stock"] + r["total_in"] - r["total_out"])
        adc = float(r["period_qty"]) / days                      # average daily consumption
        minimum = round(adc * s["safety_stock_days"], 1)
        reorder_point = round(adc * s["lead_time_days"] + minimum, 1)
        eoq = round(sqrt(2 * adc * 365 * s["ordering_cost"] / (cost * hold)), 1) if adc > 0 and cost > 0 and hold > 0 else 0.0
        maximum = round(reorder_point + eoq, 1)
        reorder_level = max(float(r["manual_reorder_level"]), reorder_point)
        issues = r["period_issues"]

        if issues >= s["fast_moving_issues"]:
            movement = "Fast moving"
        elif issues > 0:
            movement = "Slow moving"
        else:
            movement = "Non-moving"

        order_qty = round(maximum - current, 1)
        if current <= 0 and issues > 0:
            tier = 5
            action = f"Out of stock - order {order_qty:g} units urgently" if order_qty > 0 else "Out of stock - order urgently"
        elif 0 < current <= reorder_level:
            tier = 4
            action = f"At or below reorder level - order {order_qty:g} units" if order_qty > 0 else "At or below reorder level - order usual quantity"
        elif maximum > 0 and current > maximum:
            tier, action = 3, ACTIONS[3]
        elif current > 0 and issues == 0:
            tier, action = 2, ACTIONS[2]
        elif current <= 0:
            tier, action = 1, ACTIONS[1]
        else:
            tier, action = 0, ""

        if tier >= 4:
            at_stake = max(adc * 30 * cost, cost)
        elif tier == 3:
            at_stake = (current - maximum) * cost
        elif tier == 2:
            at_stake = current * cost
        else:
            at_stake = 0.0

        unique = names[r["name"].strip().lower()] == 1
        label = r["name"].strip() if unique else f"{r['name'].strip()}{' - ' + r['unit'] if r['unit'] else ''} [{r['sku']}]"

        r.update(
            label=label,
            current_stock=current,
            total_value=current * cost,
            avg_daily=adc,
            min_stock=minimum,
            reorder_point=reorder_point,
            max_stock=maximum,
            eoq=eoq,
            reorder_level=reorder_level,
            status="Reorder" if current <= reorder_level else "OK",
            movement=movement,
            consumption_pct=pct(r["month_value"], total_month_value),
            action=action,
            tier=tier,
            at_stake=at_stake,
        )
    return rows


def top_actions(items: list[dict], n: int = 20) -> list[dict]:
    ranked = [i for i in items if i["tier"] > 0]
    ranked.sort(key=lambda i: (-i["tier"], -i["at_stake"], i["sku"]))
    return ranked[:n]


def store_costing(items: list[dict]) -> list[dict]:
    total = sum(i["total_value"] for i in items)
    stores = STORES + sorted({i["store"] for i in items} - set(STORES))
    out = []
    for s in stores:
        rows = [i for i in items if i["store"] == s]
        value = sum(i["total_value"] for i in rows)
        out.append({
            "store": s,
            "skus": len(rows),
            "value": value,
            "pct": pct(value, total),
            "low_stock": sum(1 for i in rows if i["status"] == "Reorder"),
            "month_consumption": float(sum(i["month_value"] for i in rows)),
        })
    return out


def expenditure(items: list[dict], n: int = 30) -> tuple[list[dict], list[dict]]:
    """Items ranked by purchase value this month: (highest, lowest). Unpurchased items are left out."""
    bought = [i for i in items if i["month_purchase_value"] > 0]
    total = sum(i["month_purchase_value"] for i in bought)
    for i in bought:
        i["purchase_pct"] = pct(i["month_purchase_value"], total)
    high = sorted(bought, key=lambda i: (-i["month_purchase_value"], i["sku"]))[:n]
    low = sorted(bought, key=lambda i: (i["month_purchase_value"], i["sku"]))[:n]
    return high, low


def _series(conn, start: date, stop: date, step: str) -> list[dict]:
    """Purchases, consumption and revenue per day or month between start (inclusive) and stop (exclusive)."""
    rows = conn.execute(
        """
        SELECT g::date AS period,
               COALESCE((SELECT SUM(qty * unit_price) FROM inbound
                         WHERE date >= g::date AND date < (g + %(step)s::interval)::date), 0) AS purchases,
               COALESCE((SELECT SUM(qty * unit_cost) FROM outbound
                         WHERE date >= g::date AND date < (g + %(step)s::interval)::date), 0) AS consumption,
               COALESCE((SELECT SUM(food_sales + beverage_sales) FROM sales
                         WHERE date >= g::date AND date < (g + %(step)s::interval)::date), 0) AS revenue
        FROM generate_series(%(start)s::timestamp, %(stop)s::timestamp - interval '1 day', %(step)s::interval) g
        ORDER BY g
        """,
        {"start": start, "stop": stop, "step": step},
    ).fetchall()
    tp = sum(r["purchases"] for r in rows)
    tc = sum(r["consumption"] for r in rows)
    for r in rows:
        r["purchase_pct"] = pct(r["purchases"], tp)
        r["consumption_pct"] = pct(r["consumption"], tc)
        r["cost_pct"] = pct(r["consumption"], r["revenue"])
    return rows


def summary(conn, as_of: date, settings: dict | None = None) -> dict:
    """Key figures for the report date and its month, plus monthly and daily tables."""
    s = settings or load_settings(conn)
    m0, m1 = month_bounds(as_of)
    daily = _series(conn, m0, m1, "1 day")
    monthly = _series(conn, date(as_of.year, 1, 1), date(as_of.year + 1, 1, 1), "1 month")
    today = next(r for r in daily if r["period"] == as_of)
    month = next(r for r in monthly if r["period"] == m0)

    split = conn.execute(
        """
        SELECT COALESCE(SUM(o.qty * o.unit_cost) FILTER (WHERE i.store = 'Dry Store'), 0) AS food_cost,
               COALESCE(SUM(o.qty * o.unit_cost) FILTER (WHERE i.store = 'Bar'), 0)       AS bev_cost
        FROM outbound o JOIN items i ON i.id = o.item_id
        WHERE o.date >= %s AND o.date < %s
        """,
        (m0, m1),
    ).fetchone()
    rev = conn.execute(
        "SELECT COALESCE(SUM(food_sales), 0) AS food, COALESCE(SUM(beverage_sales), 0) AS bev FROM sales WHERE date >= %s AND date < %s",
        (m0, m1),
    ).fetchone()
    food_cost_pct = pct(split["food_cost"], rev["food"])

    def totals(rows):
        p, c, r = (sum(x[k] for x in rows) for k in ("purchases", "consumption", "revenue"))
        return {"purchases": p, "consumption": c, "revenue": r, "cost_pct": pct(c, r)}

    return {
        "as_of": as_of,
        "month_start": m0,
        "today": {**today, "purchase_of_revenue": pct(today["purchases"], today["revenue"])},
        "month": {**month, "purchase_of_revenue": pct(month["purchases"], month["revenue"])},
        "food_cost_pct": food_cost_pct,
        "beverage_cost_pct": pct(split["bev_cost"], rev["bev"]),
        "food_cost_over_target": food_cost_pct is not None and food_cost_pct > s["target_food_cost_pct"],
        "target_food_cost_pct": s["target_food_cost_pct"],
        "daily": daily,
        "daily_total": totals(daily),
        "monthly": monthly,
        "monthly_total": totals(monthly),
    }


def department_summary(conn, as_of: date) -> list[dict]:
    m0, m1 = month_bounds(as_of)
    rows = conn.execute(
        """
        SELECT d.name AS department,
               COALESCE(SUM(o.qty), 0)               AS units,
               COUNT(o.id)                           AS dispatches,
               COALESCE(SUM(o.qty * o.unit_cost), 0) AS value,
               COALESCE(SUM(o.qty * o.unit_cost) FILTER (WHERE o.date >= %s AND o.date < %s), 0) AS month_value
        FROM (SELECT name FROM departments UNION SELECT DISTINCT department FROM outbound) d
        LEFT JOIN outbound o ON o.department = d.name AND o.date <= %s
        GROUP BY d.name
        ORDER BY value DESC, d.name
        """,
        (m0, m1, as_of),
    ).fetchall()
    total = sum(r["value"] for r in rows)
    for r in rows:
        r["pct"] = pct(r["value"], total)
    return rows


def find_item(items: list[dict], text: str) -> dict | None:
    """Resolve what was typed in an item search box: exact label, SKU, exact name, then a single partial match."""
    t = (text or "").strip().lower()
    if not t:
        return None
    for key in ("label", "sku", "name"):
        hits = [i for i in items if i[key].strip().lower() == t]
        if len(hits) == 1:
            return hits[0]
    hits = [i for i in items if t in i["label"].lower()]
    return hits[0] if len(hits) == 1 else None
