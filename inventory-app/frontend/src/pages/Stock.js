import React, { useCallback, useEffect, useMemo, useState } from "react";
import api, { errorMessage } from "../services/api";
import { money, num, label } from "../utils/format";
import { useCanApprove } from "../utils/roles";

const STATUS_ORDER = { OUT_OF_STOCK: 0, BELOW_SAFETY_STOCK: 1, REORDER: 2, OK: 3, OVERSTOCK: 4 };
const EMPTY_ITEM = { sku: "", barcode: "", itemName: "", category: "", unitOfMeasure: "kg", orderMultiple: 1, shelfLifeDays: "", preferredVendorId: "" };
const ADJUSTMENT_TEXT = {
  SHELF_LIFE_CAP: "capped at shelf life",
  FORWARD_BUY: "extra cover: price rising",
};
const indent = (c) => "\u00a0\u00a0\u00a0".repeat(c.level - 1) + c.name;

// Codes of a category and every category below it.
const withDescendants = (categories, code) => {
  const result = new Set([code]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of categories) {
      if (c.parentCode && result.has(c.parentCode) && !result.has(c.code)) {
        result.add(c.code);
        grew = true;
      }
    }
  }
  return result;
};

export default function Stock() {
  const [rows, setRows] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [categories, setCategories] = useState([]);
  const [onlyReorder, setOnlyReorder] = useState(false);
  const [category, setCategory] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [newItem, setNewItem] = useState(EMPTY_ITEM);
  const [showAdd, setShowAdd] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const canApprove = useCanApprove();

  const load = useCallback(async () => {
    try {
      const [plan, vendorList, categoryList] = await Promise.all([api.get("/replenishment"), api.get("/vendors"), api.get("/categories")]);
      setRows(plan.data);
      setVendors(vendorList.data);
      setCategories(categoryList.data);
      setError("");
    } catch (err) {
      setError(errorMessage(err, "Unable to load stock"));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const categoryName = useMemo(() => new Map(categories.map((c) => [c.code, c.name])), [categories]);
  const visible = useMemo(() => {
    const codes = category ? withDescendants(categories, category) : null;
    return rows
      .filter((r) => (!onlyReorder || r.needsReorder) && (!codes || codes.has(r.category)))
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.itemName.localeCompare(b.itemName));
  }, [rows, onlyReorder, category, categories]);

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const recalculate = async () => {
    try {
      const res = await api.post("/replenishment/recalculate");
      setMessage(`Levels recalculated for ${res.data.levelsUpdated} items; ABC/XYZ updated for ${res.data.itemsUpdated}.`);
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const generatePurchaseOrders = async () => {
    try {
      const itemIds = selected.size ? [...selected] : undefined;
      const res = await api.post("/replenishment/purchase-orders", { itemIds });
      const unassigned = res.data.unassigned.length ? ` ${res.data.unassigned.length} item(s) have no vendor.` : "";
      setMessage(`Created ${res.data.created.length} draft purchase order(s): ${res.data.created.map((p) => p.poNumber).join(", ")}.${unassigned}`);
      setSelected(new Set());
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const addItem = async (e) => {
    e.preventDefault();
    try {
      await api.post("/items", {
        ...newItem,
        preferredVendorId: newItem.preferredVendorId || null,
        shelfLifeDays: newItem.shelfLifeDays === "" ? undefined : Number(newItem.shelfLifeDays),
      });
      setNewItem(EMPTY_ITEM);
      setShowAdd(false);
      setMessage("Item added.");
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const field = (name) => ({
    value: newItem[name],
    onChange: (e) => setNewItem({ ...newItem, [name]: e.target.value }),
  });

  const reorderCount = rows.filter((r) => r.needsReorder).length;

  return (
    <div className="page">
      <h2>Stock &amp; Replenishment</h2>
      <p className="muted">
        Daily demand is forecast from up to a year of issues (weighted moving average or trend smoothing, whichever
        predicted recent weeks better, with a month-of-year seasonal factor). Safety stock, reorder point and maximum
        stock use that forecast and each vendor's actual delivery lead time; the maximum is capped at what can be used
        within the item's shelf life. Order quantity = maximum − (on hand + on order) in whole packs, suggested once the
        stock position falls to the reorder point.
      </p>
      {error && <p className="error">{error}</p>}
      {message && <p className="notice">{message}</p>}

      <div className="toolbar">
        <label>
          <input type="checkbox" checked={onlyReorder} onChange={(e) => setOnlyReorder(e.target.checked)} /> Only items to
          reorder ({reorderCount})
        </label>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.code} value={c.code}>{indent(c)}</option>
          ))}
        </select>
        {canApprove && (
          <>
            <button type="button" onClick={recalculate}>Recalculate levels &amp; ABC/XYZ</button>
            <button type="button" className="primary" onClick={generatePurchaseOrders} disabled={reorderCount === 0}>
              Create draft POs {selected.size ? `for ${selected.size} selected` : "for all reorder items"}
            </button>
            <button type="button" onClick={() => setShowAdd(!showAdd)}>{showAdd ? "Close" : "Add item"}</button>
          </>
        )}
      </div>

      {canApprove && showAdd && (
        <form className="card form-grid" onSubmit={addItem}>
          <label>SKU<input required {...field("sku")} /></label>
          <label>Barcode<input required {...field("barcode")} /></label>
          <label>Item name<input required {...field("itemName")} /></label>
          <label>Category
            <select required {...field("category")}>
              <option value="">Select…</option>
              {categories.map((c) => (
                <option key={c.code} value={c.code} disabled={c.level === 1}>{indent(c)}</option>
              ))}
            </select>
          </label>
          <label>Shelf life (days)
            <input type="number" min="1" step="1" placeholder={`category default ${categories.find((c) => c.code === newItem.category)?.defaultShelfLifeDays ?? "–"}`} {...field("shelfLifeDays")} />
          </label>
          <label>Unit<input required placeholder="kg, ltr, pcs, pack" {...field("unitOfMeasure")} /></label>
          <label>Pack size (order multiple)<input type="number" min="0.001" step="any" {...field("orderMultiple")} /></label>
          <label>Preferred vendor
            <select {...field("preferredVendorId")}>
              <option value="">—</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.vendorName}</option>)}
            </select>
          </label>
          <label>&nbsp;<button type="submit" className="primary">Save item</button></label>
        </form>
      )}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th />
              <th>Item</th>
              <th>Status</th>
              <th className="num">On hand</th>
              <th className="num">Value</th>
              <th className="num">On order</th>
              <th className="num">Avg/day</th>
              <th className="num" title="Forecast daily demand over lead time + review period">Forecast/day</th>
              <th className="num">Days cover</th>
              <th>Vendor</th>
              <th className="num" title="Lead time in days (actual average where delivery history exists)">Lead time</th>
              <th className="num" title="Safety stock / minimum">Min (SS)</th>
              <th className="num">Reorder pt</th>
              <th className="num">Max</th>
              <th className="num">Order qty</th>
              <th className="num">Order value</th>
              <th title="ABC by consumption value, XYZ by demand variability">Class</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.itemId} className={selected.has(r.itemId) ? "selected" : ""}>
                <td>
                  {canApprove && r.needsReorder && (
                    <input type="checkbox" checked={selected.has(r.itemId)} onChange={() => toggle(r.itemId)} />
                  )}
                </td>
                <td>
                  {r.itemName}
                  <div className="muted">{r.sku} · {categoryName.get(r.category) ?? label(r.category)}</div>
                </td>
                <td><span className={`badge ${r.status}`}>{label(r.status)}</span></td>
                <td className="num">{num(r.centralOnHand, 3)} {r.unitOfMeasure}</td>
                <td className="num">{money(r.centralValue)}</td>
                <td className="num">{num(r.onOrder, 3)}</td>
                <td className="num">{num(r.avgDailyUsage, 2)}</td>
                <td className="num" title={r.forecastMethod ? `${r.forecastMethod}${r.forecastAccuracyPct !== null ? `, ${r.forecastAccuracyPct}% accurate on recent weeks` : ""}${r.seasonalIndex !== 1 ? `, seasonal ×${r.seasonalIndex}` : ""}` : ""}>
                  {num(r.forecastDailyDemand, 2)}
                  {r.forecastMethod && <div className="muted">{r.forecastMethod}</div>}
                </td>
                <td className="num">{num(r.daysOfCover)}</td>
                <td>{r.vendorName || "—"}</td>
                <td className="num" title={label(r.leadTimeSource)}>{num(r.leadTimeDays)} d</td>
                <td className="num">{r.minStock}</td>
                <td className="num">{r.reorderPoint}</td>
                <td className="num">
                  {r.maxStock}
                  {r.planningSource === "MANUAL" && <div className="muted">manual</div>}
                  {r.planningSource !== "MANUAL" && r.planningAdjustments?.map((a) => <div key={a} className="muted">{ADJUSTMENT_TEXT[a]}</div>)}
                </td>
                <td className="num"><strong>{r.suggestedOrderQty || ""}</strong></td>
                <td className="num">{r.suggestedOrderQty ? money(r.suggestedOrderValue) : ""}</td>
                <td>
                  <span className={`badge ${r.abcCategory}`}>{r.abcCategory}</span>
                  <span className="badge">{r.xyzCategory}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
