import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, LabelList } from "recharts";
import api, { errorMessage } from "../services/api";
import { money, num, pct, date, label } from "../utils/format";
import { useCanApprove } from "../utils/roles";
import { SERIES, OTHER, INK, compactMoney, PRESETS, isoDay, axisProps, Kpi, ValueTooltip, ChartCard, Donut } from "../components/ReportKit";

const GROUP_COLORS = { FOOD: SERIES[0], BEVERAGE: SERIES[1], NON_FOOD: SERIES[2] };
const HEALTH_ORDER = { EXPIRED: 0, AT_RISK: 1, NON_MOVING: 2, SLOW: 3, HEALTHY: 4 };
const ADJUSTMENT_TEXT = { SHELF_LIFE_CAP: "capped at shelf life", FORWARD_BUY: "forward buy (price rising)" };

function AbcXyzMatrix({ matrix }) {
  const cell = (abc, xyz) => matrix.cells.find((c) => c.abc === abc && c.xyz === xyz);
  return (
    <section className="card report-card wide">
      <header className="report-card-head">
        <div>
          <h3>ABC-XYZ matrix</h3>
          <p className="muted">
            ABC by annual consumption value (A = first 80%, B = next 15%, C = last 5%); XYZ by week-to-week demand
            variation (X: CV ≤ 0.5, Y: ≤ 1.0, Z: above). Each cell shows items, share of consumption value and the control policy.
          </p>
        </div>
      </header>
      <div className="abc-matrix" role="table" aria-label="ABC-XYZ matrix">
        <div className="abc-corner" role="columnheader" />
        {["X steady", "Y variable", "Z erratic"].map((h) => <div key={h} className="abc-head" role="columnheader">{h}</div>)}
        {["A", "B", "C"].map((abc) => (
          <React.Fragment key={abc}>
            <div className="abc-head" role="rowheader">{abc} {abc === "A" ? "high value" : abc === "B" ? "medium" : "low value"}</div>
            {["X", "Y", "Z"].map((xyz) => {
              const c = cell(abc, xyz);
              return (
                <div key={xyz} className={`abc-cell abc-${abc}`} role="cell">
                  <div className="abc-cell-top">
                    <strong>{abc}{xyz}</strong>
                    <span>{c.items} item{c.items === 1 ? "" : "s"} · {pct(c.valueSharePct)}</span>
                  </div>
                  <p>{c.policy}</p>
                  {c.topItems.length > 0 && <p className="muted">{c.topItems.map((i) => i.itemName).join(", ")}</p>}
                </div>
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </section>
  );
}

function RevenueForm({ outlets, onSaved, onError }) {
  const [outletId, setOutletId] = useState("");
  const [businessDate, setBusinessDate] = useState(isoDay(new Date(Date.now() - 864e5)));
  const [revenue, setRevenue] = useState("");
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.put(`/departments/${outletId}/revenue`, { businessDate, revenue: Number(revenue) });
      setRevenue("");
      onSaved();
    } catch (err) {
      onError(errorMessage(err));
    }
  };
  return (
    <form className="toolbar" onSubmit={submit} aria-label="Record outlet revenue">
      <strong>Record sales</strong>
      <select required value={outletId} onChange={(e) => setOutletId(e.target.value)} aria-label="Outlet">
        <option value="">Outlet…</option>
        {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
      <input type="date" required value={businessDate} onChange={(e) => setBusinessDate(e.target.value)} aria-label="Business date" />
      <input type="number" required min="0" step="0.01" placeholder="Revenue" value={revenue} onChange={(e) => setRevenue(e.target.value)} aria-label="Revenue" />
      <button type="submit">Save</button>
    </form>
  );
}

export default function Valuation() {
  const canApprove = useCanApprove();
  const [preset, setPreset] = useState("30");
  const [data, setData] = useState(null);
  const [outlets, setOutlets] = useState([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const to = new Date();
    const from = isoDay(new Date(to.getTime() - Number(preset) * 864e5));
    try {
      const [daily, cogs, health, matrix, forecast, depts] = await Promise.all([
        api.get("/valuation/daily", { params: { from, to: isoDay(new Date(to.getTime() - 864e5)) } }),
        api.get("/reports/outlet-cogs", { params: { from, to: isoDay(to) } }),
        api.get("/reports/inventory-health"),
        api.get("/reports/abc-xyz"),
        api.get("/reports/forecast"),
        api.get("/departments"),
      ]);
      setData({ daily: daily.data, cogs: cogs.data, health: health.data, matrix: matrix.data, forecast: forecast.data });
      setOutlets(depts.data);
      setError("");
    } catch (err) {
      setError(errorMessage(err, "Unable to load valuation"));
    } finally {
      setLoading(false);
    }
  }, [preset]);

  useEffect(() => {
    load();
  }, [load]);

  const rebuild = async () => {
    try {
      const to = new Date(Date.now() - 864e5);
      const res = await api.post("/valuation/snapshots", { from: isoDay(new Date(to.getTime() - (Number(preset) - 1) * 864e5)), to: isoDay(to) });
      setMessage(`Closing valuation rebuilt for ${res.data.from} – ${res.data.to} (${res.data.rows} item-days).`);
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const healthRows = useMemo(
    () => (data ? [...data.health.items].sort((a, b) => HEALTH_ORDER[a.status] - HEALTH_ORDER[b.status] || b.stockValueWac - a.stockValueWac) : []),
    [data]
  );

  if (!data) {
    return (
      <div className="page reports">
        <h2>Valuation &amp; Cost Control</h2>
        {error ? <p className="error">{error}</p> : <p>Loading…</p>}
      </div>
    );
  }

  const { daily, cogs, health, matrix, forecast } = data;
  const last = daily.days[daily.days.length - 1];
  const hs = health.summary;
  const groupRows = cogs.byGroup.map((g) => ({ key: g.code, name: g.name, value: g.cogs }));
  const outletRows = cogs.outlets.map(({ byGroup, ...o }) => ({
    ...o,
    food: byGroup.FOOD ?? 0,
    beverage: byGroup.BEVERAGE ?? 0,
    nonFood: byGroup.NON_FOOD ?? 0,
  }));
  const outletBars = cogs.outlets.filter((o) => o.cogs > 0).map((o) => ({ name: o.name, value: o.cogs, sharePct: o.sharePct }));

  return (
    <div className="page reports">
      <h2>Valuation &amp; Cost Control</h2>
      <p className="muted">
        Book value is weighted average cost (WAC); FIFO prices the same quantity at the latest purchase prices for comparison.
        Cost of goods per outlet is the value issued to it from the central store; cost % divides it by the outlet's recorded sales.
      </p>
      <div className="toolbar">
        <select value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Period">
          {PRESETS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </select>
        <span className="muted">{date(cogs.from)} – {date(cogs.to)}</span>
        {canApprove && <button type="button" onClick={rebuild}>Rebuild closing valuation</button>}
      </div>
      {error && <p className="error" onClick={() => setError("")}>{error}</p>}
      {message && <p className="notice">{message}</p>}

      <div style={{ opacity: loading ? 0.5 : 1, transition: "opacity 120ms" }}>
        <div className="kpis">
          <Kpi label="Stock value (WAC)" value={money(hs.stockValue)} note="central store, now" />
          <Kpi label="Stock value (FIFO)" value={money(last?.closingValueFifo)} note={last ? `closing ${date(last.date)}` : "no snapshot yet"} />
          <Kpi label="Days on hand" value={num(hs.daysOnHand)} note="stock ÷ average daily issues (30 days)" />
          <Kpi label="Stock turnover" value={hs.annualTurnover === null ? "–" : `${num(hs.annualTurnover)}×`} note="per year" />
          <Kpi label="Cost of goods" value={money(cogs.totals.cogs)} note="issued to outlets" />
          <Kpi label="Cost % of sales" value={pct(cogs.totals.costPct)} note={cogs.totals.revenue ? `sales ${money(cogs.totals.revenue)}` : "record outlet sales"} />
          <Kpi label="Non-moving stock" value={money(hs.nonMovingValue)} note={`no issues for ${health.slowMovingDays}+ days`} />
          <Kpi label="Expired / at risk" value={money(hs.expiredValue + hs.atRiskValue)} note={`${money(hs.expiredValue)} past expiry`} />
        </div>

        <div className="report-grid">
          <ChartCard
            wide
            title="Closing stock value by day"
            subtitle="End-of-day value of the central store at weighted average cost (book) and at FIFO"
            rows={daily.days}
            columns={[
              { key: "date", label: "Date", format: date },
              { key: "openingValue", label: "Opening", numeric: true, format: money },
              { key: "receivedValue", label: "Received", numeric: true, format: money },
              { key: "issuedValue", label: "Issued", numeric: true, format: money },
              { key: "wasteValue", label: "Waste", numeric: true, format: money },
              { key: "adjustmentValue", label: "Adjustments", numeric: true, format: money },
              { key: "closingValueWac", label: "Closing (WAC)", numeric: true, format: money },
              { key: "closingValueFifo", label: "Closing (FIFO)", numeric: true, format: money },
              { key: "daysOnHand", label: "Days on hand", numeric: true, format: (v) => num(v) },
            ]}
          >
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={daily.days} margin={{ top: 8, right: 24, left: 8, bottom: 4 }}>
                <CartesianGrid vertical={false} stroke={INK.grid} />
                <XAxis dataKey="date" {...axisProps} tickFormatter={(d) => date(d)} minTickGap={32} />
                <YAxis {...axisProps} axisLine={false} tickFormatter={compactMoney} width={72} />
                <Tooltip content={<ValueTooltip labelFormat={(d) => date(d)} />} cursor={{ stroke: INK.axis }} />
                <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
                <Line type="linear" dataKey="closingValueWac" name="Book value (WAC)" stroke={SERIES[0]} strokeWidth={2} dot={false} />
                <Line type="linear" dataKey="closingValueFifo" name="FIFO value" stroke={SERIES[1]} strokeWidth={2} strokeDasharray="5 4" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard
            wide
            title="Cost of goods by outlet"
            subtitle="Value issued to each kitchen, bar and department, with its share of the total"
            rows={outletRows}
            columns={[
              { key: "name", label: "Outlet" },
              { key: "outletType", label: "Type", format: label },
              { key: "costCenter", label: "Cost centre" },
              { key: "cogs", label: "Cost of goods", numeric: true, format: money },
              { key: "sharePct", label: "Share", numeric: true, format: (v) => pct(v) },
              { key: "food", label: "Food", numeric: true, format: money },
              { key: "beverage", label: "Beverages", numeric: true, format: money },
              { key: "nonFood", label: "Non-food", numeric: true, format: money },
              { key: "revenue", label: "Sales", numeric: true, format: money },
              { key: "costPct", label: "Cost %", numeric: true, format: (v) => pct(v) },
              { key: "wasteMemo", label: "Outlet waste", numeric: true, format: money },
            ]}
          >
            <ResponsiveContainer width="100%" height={Math.max(220, outletBars.length * 32 + 40)}>
              <BarChart data={outletBars} layout="vertical" margin={{ top: 4, right: 96, left: 8, bottom: 4 }} barCategoryGap={6}>
                <CartesianGrid horizontal={false} stroke={INK.grid} />
                <XAxis type="number" {...axisProps} tickFormatter={compactMoney} />
                <YAxis type="category" dataKey="name" width={170} {...axisProps} axisLine={false} interval={0} />
                <Tooltip cursor={{ fill: "rgba(42,120,214,0.08)" }} content={<ValueTooltip />} />
                <Bar dataKey="value" name="Cost of goods" fill={SERIES[0]} radius={[0, 4, 4, 0]} maxBarSize={18}>
                  <LabelList dataKey="sharePct" position="right" fill="#52514e" fontSize={12} formatter={(v) => `${num(v)}%`} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard
            title="Cost of goods by group"
            subtitle="Food, beverages and non-food supplies"
            rows={groupRows}
            columns={[
              { key: "name", label: "Group" },
              { key: "value", label: "Cost of goods", numeric: true, format: money },
            ]}
          >
            <Donut data={groupRows} colors={(d) => GROUP_COLORS[d.key] ?? OTHER} />
          </ChartCard>

          <ChartCard
            title="Cost % of sales by outlet type"
            subtitle="Outlets with recorded sales only"
            rows={cogs.byOutletType.filter((r) => r.costPct !== null)}
            columns={[
              { key: "key", label: "Outlet type", format: label },
              { key: "cogs", label: "Cost of goods", numeric: true, format: money },
              { key: "revenue", label: "Sales", numeric: true, format: money },
              { key: "costPct", label: "Cost %", numeric: true, format: (v) => pct(v) },
            ]}
            tableOnly
          />

          {canApprove && (
            <section className="card report-card wide">
              <RevenueForm outlets={outlets} onSaved={() => { setMessage("Sales saved."); load(); }} onError={setError} />
            </section>
          )}

          <ChartCard
            wide
            tableOnly
            scrollTable
            title="Stock health: days on hand, turnover and age"
            subtitle={`Non-moving = no issues for ${health.slowMovingDays}+ days; slow = more than ${health.slowMovingDays} days on hand; at risk = expires within ${health.expiringWithinDays} days faster than it is used`}
            rows={healthRows}
            columns={[
              { key: "itemName", label: "Item" },
              { key: "status", label: "Status", format: (v) => <span className={`badge ${v}`}>{label(v)}</span> },
              { key: "onHand", label: "On hand", numeric: true, format: (v) => num(v, 3) },
              { key: "stockValueWac", label: "Value (WAC)", numeric: true, format: money },
              { key: "avgDailyConsumptionValue", label: "Issues/day", numeric: true, format: money },
              { key: "daysOnHand", label: "Days on hand", numeric: true, format: (v) => num(v) },
              { key: "annualTurnover", label: "Turns/yr", numeric: true, format: (v) => num(v) },
              { key: "avgAgeDays", label: "Avg age (d)", numeric: true, format: (v) => num(v) },
              { key: "daysSinceLastIssue", label: "Since last issue (d)", numeric: true, format: (v) => num(v, 0) },
              { key: "nextExpiry", label: "Next expiry", format: date },
              { key: "atRiskValue", label: "At risk", numeric: true, format: money },
              { key: "expiredValue", label: "Expired", numeric: true, format: money },
            ]}
          />

          <AbcXyzMatrix matrix={matrix} />

          <ChartCard
            wide
            tableOnly
            scrollTable
            title="Demand forecast and reorder levels"
            subtitle="Forecast daily demand (method chosen by back-test on recent weeks) and the stock levels it drives"
            rows={forecast.map((r) => ({ ...r, adjusted: r.planningAdjustments.map((a) => ADJUSTMENT_TEXT[a]).join(", ") }))}
            columns={[
              { key: "itemName", label: "Item" },
              { key: "avgDailyUsage", label: "Avg/day", numeric: true, format: (v) => num(v, 2) },
              { key: "forecastDailyDemand", label: "Forecast/day", numeric: true, format: (v) => num(v, 2) },
              { key: "forecastMethod", label: "Method" },
              { key: "forecastAccuracyPct", label: "Accuracy", numeric: true, format: (v) => pct(v) },
              { key: "seasonalIndex", label: "Season ×", numeric: true, format: (v) => num(v, 2) },
              { key: "leadTimeDays", label: "Lead time (d)", numeric: true, format: (v) => num(v) },
              { key: "safetyStock", label: "Safety stock", numeric: true },
              { key: "reorderPoint", label: "Reorder pt", numeric: true },
              { key: "maxStock", label: "Max", numeric: true },
              { key: "adjusted", label: "Adjusted" },
              { key: "stockPosition", label: "Position", numeric: true, format: (v) => num(v, 3) },
              { key: "suggestedOrderQty", label: "Order qty", numeric: true, format: (v) => (v ? num(v, 3) : "") },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
