"""End-to-end tests against a real PostgreSQL database.

Set TEST_DATABASE_URL to an empty database the tests may wipe, e.g.
    TEST_DATABASE_URL=postgresql://inv:inv@localhost:5432/inventory_test pytest
"""
import os
import re
import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import db  # noqa: E402
import metrics  # noqa: E402
from app import create_app  # noqa: E402

URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL not set")
TODAY = date.today()


@pytest.fixture()
def conn():
    with db.connect(URL) as c:
        c.execute("DROP TABLE IF EXISTS inbound, outbound, sales, departments, settings, items CASCADE")
        db.init_schema(c)
        c.execute(
            """INSERT INTO items (sku, name, category, store, unit, unit_cost, opening_stock, manual_reorder_level) VALUES
               ('DRY-001', 'maida', 'dry', 'Dry Store', '1kg', 45, 28, 1),
               ('DRY-002', 'star anise', 'dry', 'Dry Store', '1kg', 950, 1, 1),
               ('DRY-003', 'star anise', 'dry', 'Dry Store', '50gm', 50, 0, 1),
               ('BAR-001', 'corona', 'beer', 'Bar', '', 95, 24, 0)"""
        )
        c.commit()
        yield c


@pytest.fixture()
def client(conn):
    app = create_app(URL)
    app.config["TESTING"] = True
    return app.test_client()


def post(client, path, **data):
    page = client.get(path).get_data(as_text=True)
    token = re.search(r'name="csrf" value="([0-9a-f]+)"', page).group(1)
    return client.post(path, data={"csrf": token, **data}, follow_redirects=True)


def by_sku(conn):
    return {i["sku"]: i for i in metrics.inventory(conn, TODAY)}


def test_opening_state(conn):
    items = by_sku(conn)
    assert items["DRY-001"]["current_stock"] == 28
    assert items["DRY-001"]["status"] == "OK"
    assert items["DRY-002"]["status"] == "Reorder"          # 1 <= reorder level 1
    assert all(i["movement"] == "Non-moving" for i in items.values())
    assert items["DRY-001"]["label"] == "maida"
    assert items["DRY-002"]["label"] == "star anise - 1kg [DRY-002]"   # duplicate names get a unique label


def test_inbound_and_outbound_update_stock(client, conn):
    r = post(client, "/inbound", item="maida", date=TODAY.isoformat(), qty="20", unit_price="50", supplier="Vendor", po_number="PO-1")
    assert "Received 20" in r.get_data(as_text=True)
    r = post(client, "/outbound", item="maida", date=TODAY.isoformat(), qty="3", department="Kitchen")
    assert "Issued 3" in r.get_data(as_text=True)
    conn.commit()
    it = by_sku(conn)["DRY-001"]
    assert (it["total_in"], it["total_out"], it["current_stock"]) == (20, 3, 45)
    assert float(it["month_purchase_value"]) == 1000
    assert float(it["month_value"]) == 135                  # 3 x unit cost 45
    assert it["consumption_pct"] == 100
    assert it["movement"] == "Slow moving"
    assert it["avg_daily"] == 3 and it["min_stock"] == 6 and it["reorder_point"] == 12
    assert it["eoq"] > 0 and it["max_stock"] == round(it["reorder_point"] + it["eoq"], 1)


def test_cannot_issue_more_than_stock(client, conn):
    r = post(client, "/outbound", item="corona", date=TODAY.isoformat(), qty="25", department="Bar")
    assert "Only 24" in r.get_data(as_text=True)
    assert conn.execute("SELECT COUNT(*) AS n FROM outbound").fetchone()["n"] == 0


def test_ambiguous_or_unknown_item_rejected(client, conn):
    for typed in ("star anise", "no such thing"):
        r = post(client, "/inbound", item=typed, date=TODAY.isoformat(), qty="1")
        assert "pick one from the search suggestions" in r.get_data(as_text=True)
    r = post(client, "/inbound", item="star anise - 50gm [DRY-003]", date=TODAY.isoformat(), qty="2")
    assert "Received 2" in r.get_data(as_text=True)
    assert by_sku(conn)["DRY-003"]["current_stock"] == 2


def test_fast_moving_and_out_of_stock_action(conn):
    for n in range(8):
        conn.execute("INSERT INTO outbound (date, item_id, department, qty, unit_cost) SELECT %s, id, 'Bar', 3, unit_cost FROM items WHERE sku = 'BAR-001'",
                     (TODAY - timedelta(days=n),))
    conn.commit()
    it = by_sku(conn)["BAR-001"]
    assert it["movement"] == "Fast moving" and it["current_stock"] == 0
    assert it["tier"] == 5 and it["action"].startswith("Out of stock - order")
    assert metrics.top_actions(list(by_sku(conn).values()))[0]["sku"] == "BAR-001"


def test_reports_and_cost_percentages(client, conn):
    post(client, "/inbound", item="corona", date=TODAY.isoformat(), qty="10", unit_price="90")
    post(client, "/outbound", item="maida", date=TODAY.isoformat(), qty="10", department="Kitchen")   # 450
    post(client, "/outbound", item="corona", date=TODAY.isoformat(), qty="4", department="Bar")        # 380
    post(client, "/sales", date=TODAY.isoformat(), food_sales="1500", beverage_sales="1900")
    conn.commit()
    s = metrics.summary(conn, TODAY)
    assert float(s["today"]["purchases"]) == 900 and float(s["month"]["consumption"]) == 830
    assert float(s["month"]["revenue"]) == 3400
    assert s["food_cost_pct"] == pytest.approx(30) and s["beverage_cost_pct"] == pytest.approx(20)
    assert s["today"]["purchase_pct"] == 100 and len(s["monthly"]) == 12
    assert float(s["daily_total"]["consumption"]) == 830
    items = metrics.inventory(conn, TODAY)
    high, low = metrics.expenditure(items)
    assert [i["sku"] for i in high] == ["BAR-001"] == [i["sku"] for i in low]
    stores = {x["store"]: x for x in metrics.store_costing(items)}
    assert stores["Bar"]["value"] == 30 * 95 and stores["Dry Store"]["value"] == 18 * 45 + 950
    depts = {d["department"]: d for d in metrics.department_summary(conn, TODAY)}
    assert depts["Kitchen"]["units"] == 10 and depts["Kitchen"]["dispatches"] == 1 and float(depts["Bar"]["value"]) == 380
    for path in ("/", "/inventory", "/inbound", "/outbound", "/departments", "/reports", "/sales", "/settings", "/reports?date=2020-02-29"):
        assert client.get(path).status_code == 200, path


def test_add_edit_item_and_csrf(client, conn):
    r = post(client, "/inventory/new", name="olive oil", category="dry", store="Dry Store", unit="1ltr", unit_cost="1399", opening_stock="5", manual_reorder_level="1")
    assert "DRY-004 added" in r.get_data(as_text=True)
    item_id = conn.execute("SELECT id FROM items WHERE sku = 'DRY-004'").fetchone()["id"]
    post(client, f"/inventory/{item_id}/edit", name="olive oil extra virgin", category="dry", store="Dry Store", unit="1ltr", unit_cost="1500", opening_stock="5", manual_reorder_level="2")
    conn.commit()
    assert by_sku(conn)["DRY-004"]["name"] == "olive oil extra virgin" and by_sku(conn)["DRY-004"]["total_value"] == 7500
    assert client.post("/inbound", data={"item": "maida", "qty": "1", "date": TODAY.isoformat()}).status_code == 400   # no CSRF token


def test_password_gate(conn, monkeypatch):
    monkeypatch.setenv("APP_PASSWORD", "s3cret")
    c = create_app(URL).test_client()
    assert c.get("/").status_code == 302
    assert "Wrong password" in post(c, "/login", password="nope").get_data(as_text=True)
    assert post(c, "/login", password="s3cret").status_code == 200
    assert c.get("/inventory").status_code == 200
