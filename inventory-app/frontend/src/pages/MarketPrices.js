import React, { useCallback, useEffect, useMemo, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";
import api, { errorMessage } from "../services/api";
import { money, pct, date, label } from "../utils/format";
import { useCanApprove } from "../utils/roles";

const COLORS = ["#3538cd", "#e04f16", "#079455", "#c11574", "#0086c9", "#ca8504", "#6938ef", "#475467"];
const Change = ({ value }) =>
  value === null || value === undefined ? "–" : <span className={value > 0 ? "up" : "down"}>{value > 0 ? "▲" : "▼"} {pct(Math.abs(value))}</span>;

function PriceEntry({ items, vendors, onSaved, onError }) {
  const [form, setForm] = useState({ itemId: "", vendorId: "", unitPrice: "", market: "" });
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.post("/market/prices", {
        itemId: form.itemId,
        vendorId: form.vendorId || undefined,
        unitPrice: form.unitPrice,
        market: form.market || undefined,
      });
      setForm({ ...form, unitPrice: "" });
      onSaved();
    } catch (err) {
      onError(errorMessage(err));
    }
  };
  const field = (name) => ({ value: form[name], onChange: (e) => setForm({ ...form, [name]: e.target.value }) });
  return (
    <form className="card line-row" onSubmit={submit}>
      <label>
        Item
        <select required {...field("itemId")}>
          <option value="">Select item…</option>
          {items.map((i) => <option key={i.id} value={i.id}>{i.itemName}</option>)}
        </select>
      </label>
      <label>
        Source
        <select {...field("vendorId")}>
          <option value="">Market rate</option>
          {vendors.map((v) => <option key={v.id} value={v.id}>Quote from {v.vendorName}</option>)}
        </select>
      </label>
      {!form.vendorId && <label>Market<input placeholder="e.g. wholesale market" {...field("market")} /></label>}
      <label>Unit price<input required type="number" min="0" step="0.01" {...field("unitPrice")} /></label>
      <button type="submit" className="primary">Record price</button>
    </form>
  );
}

function Trend({ itemId }) {
  const [days, setDays] = useState(90);
  const [trend, setTrend] = useState(null);

  useEffect(() => {
    api.get(`/market/items/${itemId}/trend`, { params: { days } }).then((res) => setTrend(res.data)).catch(() => setTrend(null));
  }, [itemId, days]);

  // Merge each series' daily points into one row per date for recharts.
  const chartData = useMemo(() => {
    if (!trend) return [];
    const byDate = new Map();
    for (const s of trend.series) {
      for (const p of s.points) {
        const row = byDate.get(p.date) ?? { date: p.date };
        row[s.key] = p.unitPrice;
        byDate.set(p.date, row);
      }
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [trend]);

  if (!trend) return null;
  return (
    <section className="card">
      <div className="toolbar">
        <h3 style={{ margin: 0 }}>{trend.item.itemName} – price trend</h3>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[30, 60, 90, 180, 365].map((d) => <option key={d} value={d}>Last {d} days</option>)}
        </select>
      </div>
      <div className="kpis">
        <div className="kpi"><div className="label">Our avg cost</div><div className="value">{money(trend.ourAverageCost)}</div></div>
        <div className="kpi"><div className="label">Latest market</div><div className="value">{money(trend.latestMarketPrice)}</div></div>
        <div className="kpi"><div className="label">7-day change</div><div className="value"><Change value={trend.change7dPct} /></div></div>
        <div className="kpi"><div className="label">vs a month ago</div><div className="value"><Change value={trend.change30dPct} /></div></div>
        <div className="kpi"><div className="label">Our cost vs market</div><div className="value"><Change value={trend.costVsMarketPct} /></div></div>
        <div className="kpi"><div className="label">Best vendor now</div><div className="value" style={{ fontSize: 16 }}>{trend.bestVendor ? `${trend.bestVendor.vendorName} @ ${money(trend.bestVendor.unitPrice)}` : "–"}</div></div>
      </div>
      <div style={{ width: "100%", height: 360 }}>
        <ResponsiveContainer>
          <LineChart data={chartData} margin={{ top: 10, right: 24, left: 24, bottom: 10 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="date" minTickGap={24} />
            <YAxis domain={["auto", "auto"]} tickFormatter={(v) => money(v)} width={90} />
            <Tooltip formatter={(v) => money(v)} />
            <Legend />
            <ReferenceLine y={trend.ourAverageCost} stroke="#b42318" strokeDasharray="4 4" label="our avg cost" />
            {trend.series.map((s, i) => (
              <Line key={s.key} type="linear" dataKey={s.key} name={s.label} stroke={COLORS[i % COLORS.length]}
                dot={s.source !== "MARKET_FEED"} strokeWidth={s.source === "MARKET_FEED" ? 2.5 : 1.5} connectNulls />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <h4>Latest price by vendor</h4>
      <table className="data">
        <thead><tr><th>Vendor</th><th className="num">Unit price</th><th>Source</th><th>Date</th></tr></thead>
        <tbody>
          {trend.vendorPrices.map((v) => (
            <tr key={v.vendorId}>
              <td>{v.vendorName}</td>
              <td className="num">{money(v.unitPrice)}</td>
              <td>{label(v.source)}</td>
              <td>{date(v.recordedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default function MarketPrices() {
  const canApprove = useCanApprove();
  const [rows, setRows] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [selected, setSelected] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [cmp, v] = await Promise.all([api.get("/market/comparison"), api.get("/vendors")]);
      setRows(cmp.data);
      setVendors(v.data);
    } catch (err) {
      setError(errorMessage(err, "Unable to load market prices"));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const syncFeed = async () => {
    try {
      const res = await api.post("/market/feed/sync");
      setMessage(`Imported ${res.data.imported} market prices.`);
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="page">
      <h2>Market Price Trends</h2>
      <p className="muted">
        Compares our weighted average cost with the latest market rate and the cheapest current vendor price (last 30
        days). Market rates come from manual entry or the configured market feed; purchase prices are captured
        automatically on every goods receipt. Click an item for its trend.
      </p>
      {error && <p className="error" onClick={() => setError("")}>{error}</p>}
      {message && <p className="notice">{message}</p>}
      {canApprove && (
        <div className="toolbar">
          <button type="button" onClick={syncFeed}>Sync market feed now</button>
        </div>
      )}
      <PriceEntry items={rows} vendors={vendors} onError={setError} onSaved={() => { setMessage("Price recorded."); load(); }} />

      <div className="split">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Our avg cost</th>
                <th className="num">Market</th>
                <th className="num">Cost vs market</th>
                <th className="num">Best vendor</th>
                <th className="num">Possible saving</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={`clickable${selected === r.id ? " selected" : ""}`} onClick={() => setSelected(r.id)}>
                  <td>{r.itemName}<div className="muted">per {r.unitOfMeasure}</div></td>
                  <td className="num">{money(r.costPrice)}</td>
                  <td className="num">{money(r.marketPrice)}<div className="muted">{date(r.marketRecordedAt)}</div></td>
                  <td className="num"><Change value={r.costVsMarketPct} /></td>
                  <td className="num">{money(r.bestVendorPrice)}<div className="muted">{r.bestVendor?.vendorName}</div></td>
                  <td className="num">{r.potentialSavingPct ? pct(r.potentialSavingPct) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>{selected ? <Trend itemId={selected} /> : <p className="muted">Select an item to see its price trend.</p>}</div>
      </div>
    </div>
  );
}
