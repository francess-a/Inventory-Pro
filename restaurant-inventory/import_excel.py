"""Load items from the store tracking workbook into PostgreSQL.

    python import_excel.py path/to/Store_In_and_Out_tracking.xlsx

Reads the Dry Store, BAR INVENTORY and HK sheets. Each item's current closing stock in the
workbook becomes its opening stock here. Running it again updates names, categories, units
and costs but leaves stock and history alone (use --reset-stock to overwrite opening stock).
"""
import argparse
import sys

from openpyxl import load_workbook

import db

# sheet -> (SKU prefix, store, first row, columns: name, category, unit, rate, closing, first grid column, default reorder level)
SHEETS = {
    "Dry Store":     ("DRY", "Dry Store",    3, {"name": 2, "category": 3, "closing": 4, "unit": 5, "rate": 6, "grid": 8}, 1),
    "BAR INVENTORY": ("BAR", "Bar",          3, {"name": 2, "category": 3, "closing": 4, "unit": None, "rate": 5, "grid": 7}, 0),
    "HK":            ("HK",  "Housekeeping", 3, {"name": 2, "category": None, "closing": 3, "unit": 4, "rate": 5, "grid": None}, 0),
}
HK_REORDER = {3: 5, 4: 30, 5: 3, 6: 10}   # thresholds from the HK sheet's reminder formulas


def num(v) -> float:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else 0.0


def closing_stock(ws, row: int, cols: dict) -> float:
    """Typed closing stock, or IN minus OUT summed across the sheet's daily grid."""
    cell = ws.cell(row, cols["closing"]).value
    if isinstance(cell, (int, float)):
        return float(cell)
    if cols["grid"] is None:
        return 0.0
    total = 0.0
    for c in range(cols["grid"], ws.max_column + 1):
        # Compared exactly, as the workbook's own SUMIF does: a header typed as "IN " (trailing space) is not counted.
        kind = str(ws.cell(2, c).value or "").upper()
        if kind == "IN":
            total += num(ws.cell(row, c).value)
        elif kind == "OUT":
            total -= num(ws.cell(row, c).value)
    return total


def read_items(path: str) -> list[dict]:
    wb = load_workbook(path)
    items = []
    for sheet, (prefix, store, first, cols, default_level) in SHEETS.items():
        if sheet not in wb.sheetnames:
            print(f"Sheet '{sheet}' not found - skipped.", file=sys.stderr)
            continue
        ws = wb[sheet]
        for row in range(first, ws.max_row + 1):
            name = ws.cell(row, cols["name"]).value
            if not isinstance(name, str) or not name.strip() or "TOTAL" in name.upper():
                continue
            items.append({
                "sku": f"{prefix}-{row - first + 1:03d}",
                "name": name.strip(),
                "category": str(ws.cell(row, cols["category"]).value or "").strip() if cols["category"] else "housekeeping",
                "store": store,
                "unit": str(ws.cell(row, cols["unit"]).value or "").strip() if cols["unit"] else "",
                "unit_cost": round(num(ws.cell(row, cols["rate"]).value), 2),
                "opening_stock": round(closing_stock(ws, row, cols), 3),
                "manual_reorder_level": HK_REORDER.get(row, default_level) if prefix == "HK" else default_level,
            })
    return items


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("workbook")
    ap.add_argument("--reset-stock", action="store_true", help="overwrite opening stock and reorder levels of existing items")
    args = ap.parse_args()

    items = read_items(args.workbook)
    extra = ", opening_stock = EXCLUDED.opening_stock, manual_reorder_level = EXCLUDED.manual_reorder_level" if args.reset_stock else ""
    with db.connect() as conn:
        db.init_schema(conn)
        for it in items:
            conn.execute(
                f"""INSERT INTO items (sku, name, category, store, unit, unit_cost, opening_stock, manual_reorder_level)
                    VALUES (%(sku)s, %(name)s, %(category)s, %(store)s, %(unit)s, %(unit_cost)s, %(opening_stock)s, %(manual_reorder_level)s)
                    ON CONFLICT (sku) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category, store = EXCLUDED.store,
                        unit = EXCLUDED.unit, unit_cost = EXCLUDED.unit_cost{extra}
                """,
                it,
            )
        conn.commit()
    by_store = {}
    for it in items:
        by_store[it["store"]] = by_store.get(it["store"], 0) + 1
    print(f"Imported {len(items)} items: " + ", ".join(f"{k} {v}" for k, v in by_store.items()))


if __name__ == "__main__":
    main()
