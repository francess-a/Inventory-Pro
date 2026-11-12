"""Restaurant inventory app: Flask + PostgreSQL, server-rendered HTML5 and CSS."""
import hmac
import os
import secrets
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from flask import Flask, abort, flash, g, redirect, render_template, request, session, url_for

import db
import metrics


def create_app(database_url: str | None = None) -> Flask:
    app = Flask(__name__)
    app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
    app.config["DATABASE_URL"] = database_url or db.database_url()
    app.config["APP_PASSWORD"] = os.environ.get("APP_PASSWORD", "")

    with db.connect(app.config["DATABASE_URL"]) as conn:
        db.init_schema(conn)

    # ---------- plumbing ----------
    def conn():
        if "conn" not in g:
            g.conn = db.connect(app.config["DATABASE_URL"])
        return g.conn

    @app.teardown_appcontext
    def close_conn(exc):
        c = g.pop("conn", None)
        if c is not None:
            if exc is None:
                c.commit()
            else:
                c.rollback()
            c.close()

    @app.before_request
    def guard():
        if "csrf" not in session:
            session["csrf"] = secrets.token_hex(16)
        if request.method == "POST":
            sent = request.form.get("csrf", "")
            if not hmac.compare_digest(sent, session["csrf"]):
                abort(400, "Form expired. Go back, reload the page and try again.")
        if app.config["APP_PASSWORD"] and not session.get("auth") and request.endpoint not in ("login", "static"):
            return redirect(url_for("login", next=request.path))

    @app.context_processor
    def inject():
        return {"csrf": session.get("csrf", ""), "as_of": as_of(), "is_today": as_of() == date.today(),
                "login_enabled": bool(app.config["APP_PASSWORD"])}

    def as_of() -> date:
        """The date reports are worked out for: ?date=YYYY-MM-DD, else today."""
        raw = request.args.get("date", "")
        try:
            return datetime.strptime(raw, "%Y-%m-%d").date()
        except ValueError:
            return date.today()

    def number(field: str, label: str, minimum=None, above=None) -> Decimal:
        raw = (request.form.get(field) or "").strip().replace(",", "")
        try:
            value = Decimal(raw)
        except InvalidOperation:
            raise ValueError(f"{label}: enter a number.")
        if not value.is_finite():
            raise ValueError(f"{label}: enter a number.")
        if minimum is not None and value < minimum:
            raise ValueError(f"{label}: must be {minimum} or more.")
        if above is not None and value <= above:
            raise ValueError(f"{label}: must be more than {above}.")
        return value

    def form_date(field: str = "date") -> date:
        try:
            return datetime.strptime(request.form.get(field, ""), "%Y-%m-%d").date()
        except ValueError:
            raise ValueError("Date: pick a valid date.")

    def text(field: str, limit: int = 200) -> str:
        return (request.form.get(field) or "").strip()[:limit]

    # ---------- formatting ----------
    @app.template_filter("money")
    def money(v):
        return "" if v is None else f"{float(v):,.2f}"

    @app.template_filter("qty")
    def qty(v):
        return "" if v is None else f"{float(v):,.3f}".rstrip("0").rstrip(".")

    @app.template_filter("pct")
    def pct(v):
        return "–" if v is None else f"{float(v):.1f}%"

    # ---------- auth (only when APP_PASSWORD is set) ----------
    @app.route("/login", methods=["GET", "POST"])
    def login():
        if not app.config["APP_PASSWORD"]:
            return redirect(url_for("dashboard"))
        if request.method == "POST":
            if hmac.compare_digest(request.form.get("password", ""), app.config["APP_PASSWORD"]):
                session["auth"] = True
                nxt = request.args.get("next", "")
                return redirect(nxt if nxt.startswith("/") and not nxt.startswith("//") else url_for("dashboard"))
            flash("Wrong password.", "error")
        return render_template("login.html")

    @app.post("/logout")
    def logout():
        session.pop("auth", None)
        return redirect(url_for("login"))

    # ---------- pages ----------
    @app.route("/")
    def dashboard():
        d = as_of()
        s = metrics.load_settings(conn())
        items = metrics.inventory(conn(), d, s)
        high, low = metrics.expenditure(items)
        return render_template(
            "dashboard.html", items=items, summary=metrics.summary(conn(), d, s),
            stores=metrics.store_costing(items), actions=metrics.top_actions(items),
            high=high, low=low,
            kpi={
                "skus": len(items),
                "value": sum(i["total_value"] for i in items),
                "low": sum(1 for i in items if i["status"] == "Reorder"),
                "out": sum(1 for i in items if i["current_stock"] <= 0),
                "fast": sum(1 for i in items if i["movement"] == "Fast moving"),
                "non": sum(1 for i in items if i["movement"] == "Non-moving"),
            },
        )

    @app.route("/inventory")
    def inventory():
        items = metrics.inventory(conn(), as_of())
        q = request.args.get("q", "").strip().lower()
        store = request.args.get("store", "")
        status = request.args.get("status", "")
        movement = request.args.get("movement", "")
        shown = [
            i for i in items
            if (not q or q in i["name"].lower() or q in i["sku"].lower() or q in i["category"].lower())
            and (not store or i["store"] == store)
            and (not status or i["status"] == status)
            and (not movement or i["movement"] == movement)
        ]
        return render_template("inventory.html", items=shown, total=len(items), stores=metrics.STORES,
                               q=request.args.get("q", ""), store=store, status=status, movement=movement)

    def save_item(item_id=None):
        name = text("name")
        if not name:
            raise ValueError("Item name: required.")
        store = text("store") or "Dry Store"
        values = {
            "name": name, "category": text("category"), "store": store, "unit": text("unit", 40),
            "unit_cost": number("unit_cost", "Unit cost", minimum=0),
            "opening_stock": number("opening_stock", "Opening stock"),
            "manual_reorder_level": number("manual_reorder_level", "Reorder level", minimum=0),
        }
        if item_id is None:
            sku = text("sku", 40).upper()
            if not sku:
                prefix = {"Dry Store": "DRY", "Bar": "BAR", "Housekeeping": "HK"}.get(store, "ITM")
                n = conn().execute(
                    "SELECT COALESCE(MAX(NULLIF(regexp_replace(sku, '\\D', '', 'g'), '')::int), 0) + 1 AS n FROM items WHERE sku LIKE %s",
                    (prefix + "-%",),
                ).fetchone()["n"]
                sku = f"{prefix}-{n:03d}"
            if conn().execute("SELECT 1 FROM items WHERE sku = %s", (sku,)).fetchone():
                raise ValueError(f"SKU {sku} already exists.")
            conn().execute(
                """INSERT INTO items (sku, name, category, store, unit, unit_cost, opening_stock, manual_reorder_level)
                   VALUES (%(sku)s, %(name)s, %(category)s, %(store)s, %(unit)s, %(unit_cost)s, %(opening_stock)s, %(manual_reorder_level)s)""",
                {**values, "sku": sku},
            )
            return sku
        conn().execute(
            """UPDATE items SET name=%(name)s, category=%(category)s, store=%(store)s, unit=%(unit)s, unit_cost=%(unit_cost)s,
                   opening_stock=%(opening_stock)s, manual_reorder_level=%(manual_reorder_level)s WHERE id=%(id)s""",
            {**values, "id": item_id},
        )

    @app.route("/inventory/new", methods=["GET", "POST"])
    def item_new():
        if request.method == "POST":
            try:
                sku = save_item()
                flash(f"Item {sku} added.", "ok")
                return redirect(url_for("inventory"))
            except ValueError as e:
                flash(str(e), "error")
        return render_template("item_form.html", item=request.form, stores=metrics.STORES, new=True)

    @app.route("/inventory/<int:item_id>/edit", methods=["GET", "POST"])
    def item_edit(item_id):
        item = conn().execute("SELECT * FROM items WHERE id = %s AND active", (item_id,)).fetchone()
        if item is None:
            abort(404)
        if request.method == "POST":
            try:
                save_item(item_id)
                flash(f"{item['sku']} saved.", "ok")
                return redirect(url_for("inventory"))
            except ValueError as e:
                flash(str(e), "error")
                item = {**item, **request.form}
        return render_template("item_form.html", item=item, stores=metrics.STORES, new=False)

    @app.post("/inventory/<int:item_id>/archive")
    def item_archive(item_id):
        conn().execute("UPDATE items SET active = FALSE WHERE id = %s", (item_id,))
        flash("Item archived. Its history is kept.", "ok")
        return redirect(url_for("inventory"))

    def pick_item(items):
        item = metrics.find_item(items, request.form.get("item", ""))
        if item is None:
            raise ValueError("Item: pick one from the search suggestions.")
        return item

    @app.route("/inbound", methods=["GET", "POST"])
    def inbound():
        items = metrics.inventory(conn(), date.today())
        if request.method == "POST":
            try:
                item = pick_item(items)
                price = text("unit_price")
                unit_price = number("unit_price", "Unit purchase price", minimum=0) if price else item["unit_cost"]
                conn().execute(
                    "INSERT INTO inbound (date, item_id, supplier, qty, unit_price, po_number) VALUES (%s, %s, %s, %s, %s, %s)",
                    (form_date(), item["id"], text("supplier"), number("qty", "Qty received", above=0), unit_price, text("po_number", 60)),
                )
                flash(f"Received {request.form['qty']} × {item['name']}.", "ok")
                return redirect(url_for("inbound"))
            except ValueError as e:
                flash(str(e), "error")
        rows = conn().execute(
            """SELECT n.*, i.sku, i.name, i.store, n.qty * n.unit_price AS total
               FROM inbound n JOIN items i ON i.id = n.item_id ORDER BY n.date DESC, n.id DESC LIMIT 200"""
        ).fetchall()
        return render_template("inbound.html", items=items, rows=rows, form=request.form, today=date.today())

    @app.route("/outbound", methods=["GET", "POST"])
    def outbound():
        items = metrics.inventory(conn(), date.today())
        departments = [r["name"] for r in conn().execute("SELECT name FROM departments ORDER BY name")]
        if request.method == "POST":
            try:
                item = pick_item(items)
                amount = number("qty", "Qty issued", above=0)
                department = text("department", 60)
                if department not in departments:
                    raise ValueError("Department: pick one from the list.")
                if float(amount) > item["current_stock"]:
                    raise ValueError(f"Only {item['current_stock']:g} of {item['name']} in stock. Record the purchase on Inbound first.")
                conn().execute(
                    "INSERT INTO outbound (date, item_id, department, qty, unit_cost, requested_by, reference) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                    (form_date(), item["id"], department, amount, item["unit_cost"], text("requested_by", 80), text("reference", 80)),
                )
                flash(f"Issued {request.form['qty']} × {item['name']} to {department}.", "ok")
                return redirect(url_for("outbound"))
            except ValueError as e:
                flash(str(e), "error")
        rows = conn().execute(
            """SELECT o.*, i.sku, i.name, i.store, o.qty * o.unit_cost AS value
               FROM outbound o JOIN items i ON i.id = o.item_id ORDER BY o.date DESC, o.id DESC LIMIT 200"""
        ).fetchall()
        return render_template("outbound.html", items=items, rows=rows, departments=departments, form=request.form, today=date.today())

    @app.post("/inbound/<int:row_id>/delete")
    def inbound_delete(row_id):
        conn().execute("DELETE FROM inbound WHERE id = %s", (row_id,))
        flash("Inbound entry deleted.", "ok")
        return redirect(url_for("inbound"))

    @app.post("/outbound/<int:row_id>/delete")
    def outbound_delete(row_id):
        conn().execute("DELETE FROM outbound WHERE id = %s", (row_id,))
        flash("Outbound entry deleted.", "ok")
        return redirect(url_for("outbound"))

    @app.route("/departments")
    def departments():
        rows = metrics.department_summary(conn(), as_of())
        return render_template("departments.html", rows=rows,
                               totals={k: sum(r[k] for r in rows) for k in ("units", "dispatches", "value", "month_value")})

    @app.route("/reports")
    def reports():
        d = as_of()
        s = metrics.load_settings(conn())
        items = metrics.inventory(conn(), d, s)
        high, low = metrics.expenditure(items)
        return render_template("reports.html", summary=metrics.summary(conn(), d, s), stores=metrics.store_costing(items),
                               actions=metrics.top_actions(items), high=high, low=low,
                               consumers=sorted((i for i in items if i["month_value"] > 0), key=lambda i: -i["month_value"])[:30])

    @app.route("/sales", methods=["GET", "POST"])
    def sales():
        if request.method == "POST":
            try:
                conn().execute(
                    """INSERT INTO sales (date, food_sales, beverage_sales, notes) VALUES (%s, %s, %s, %s)
                       ON CONFLICT (date) DO UPDATE SET food_sales = EXCLUDED.food_sales,
                           beverage_sales = EXCLUDED.beverage_sales, notes = EXCLUDED.notes""",
                    (form_date(), number("food_sales", "Food sales", minimum=0), number("beverage_sales", "Beverage sales", minimum=0), text("notes")),
                )
                flash("Sales saved.", "ok")
                return redirect(url_for("sales"))
            except ValueError as e:
                flash(str(e), "error")
        rows = conn().execute("SELECT *, food_sales + beverage_sales AS total FROM sales ORDER BY date DESC LIMIT 120").fetchall()
        return render_template("sales.html", rows=rows, form=request.form, today=date.today())

    @app.route("/settings", methods=["GET", "POST"])
    def settings():
        if request.method == "POST":
            try:
                if request.form.get("form") == "department":
                    name = text("name", 60)
                    if not name:
                        raise ValueError("Department: enter a name.")
                    conn().execute("INSERT INTO departments (name) VALUES (%s) ON CONFLICT DO NOTHING", (name,))
                    flash(f"Department {name} added.", "ok")
                elif request.form.get("form") == "remove_department":
                    conn().execute("DELETE FROM departments WHERE name = %s", (text("name", 60),))
                    flash("Department removed. Past issues keep their department.", "ok")
                else:
                    for key, (label, _) in metrics.SETTING_LABELS.items():
                        value = number(key, label, minimum=0)
                        if key in ("movement_period_days",) and value < 1:
                            raise ValueError(f"{label}: must be at least 1.")
                        conn().execute(
                            "INSERT INTO settings (key, value) VALUES (%s, %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                            (key, str(value)),
                        )
                    flash("Settings saved.", "ok")
                return redirect(url_for("settings"))
            except ValueError as e:
                flash(str(e), "error")
        return render_template("settings.html", values=metrics.load_settings(conn()), labels=metrics.SETTING_LABELS,
                               departments=[r["name"] for r in conn().execute("SELECT name FROM departments ORDER BY name")])

    return app


if __name__ == "__main__":
    create_app().run(host="0.0.0.0", port=int(os.environ.get("PORT", "8000")), debug=bool(os.environ.get("FLASK_DEBUG")))
