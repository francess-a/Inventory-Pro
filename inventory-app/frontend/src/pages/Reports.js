import React, { useCallback, useEffect, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
} from "recharts";
import api, { errorMessage } from "../services/api";
import { money, num, pct, date } from "../utils/format";

// Categorical slots in fixed order (validated for colour-vision deficiency); never cycled.
const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"];
const OTHER = "#b4b2a9";
const SEQUENTIAL = "#2a78d6";
// Status colours are reserved for stock status and always shown with a text label.
const STATUS_COLORS = {
  OUT_OF_STOCK: "#d03b3b",
  BELOW_SAFETY_STOCK: "#ec835a",
  REORDER: "#fab219",
  OK: "#0ca30c",
  OVERSTOCK: "#898781",
};
const INK = { muted: "#898781", grid: "#e1e0d9", axis: "#c3c2b7" };

const compactMoney = (value) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: process.env.REACT_APP_CURRENCY || "INR",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);

const PRESETS = [
  ["30", "Last 30 days"],
  ["90", "Last 90 days"],
  ["180", "Last 180 days"],
  ["365", "Last 12 months"],
];

const isoDay = (d) => d.toISOString().slice(0, 10);

const toCsv = (columns, rows) =>
  [columns.map((c) => c.label), ...rows.map((r) => columns.map((c) => r[c.key] ?? ""))]
    .map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");

const downloadCsv = (name, columns, rows) => {
  const blob = new Blob([toCsv(columns, rows)], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};

// Value first, series name second; keyed with a short stroke of the series colour.
function ValueTooltip({ active, payload, label, format = money, labelFormat = (l) => l }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="viz-tooltip">
      {label !== undefined && <div className="viz-tooltip-title">{labelFormat(label)}</div>}
      {payload.map((p) => (
        <div key={p.dataKey ?? p.name} className="viz-tooltip-row">
          <span className="viz-key" style={{ background: p.color || p.payload?.fill }} />
          <strong>{p.value === null || p.value === undefined ? "–" : format(p.value)}</strong>
          <span className="muted">{p.name}</span>
        </div>
      ))}
    </div>
  );
}

function ChartCard({ title, subtitle, columns, rows, wide, children }) {
  const [showTable, setShowTable] = useState(false);
  return (
    <section className={`card report-card${wide ? " wide" : ""}`}>
      <header className="report-card-head">
        <div>
          <h3>{title}</h3>
          {subtitle && <p className="muted">{subtitle}</p>}
        </div>
        <div className="report-card-actions">
          <button type="button" className="link" onClick={() => setShowTable(!showTable)}>
            {showTable ? "Chart" : "Table"}
          </button>
          <button type="button" className="link" onClick={() => downloadCsv(title, columns, rows)} disabled={!rows.length}>
            CSV
          </button>
        </div>
      </header>
      {rows.length === 0 ? (
        <p className="muted empty">No data in this period.</p>
      ) : showTable ? (
        <div className="table-wrap report-table">
          <table className="data">
            <thead>
              <tr>{columns.map((c) => <th key={c.key} className={c.numeric ? "num" : ""}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c.key} className={c.numeric ? "num" : ""}>{c.format ? c.format(r[c.key]) : r[c.key]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="report-chart">{children}</div>
      )}
    </section>
  );
}

const axisProps = { stroke: INK.axis, tick: { fill: INK.muted, fontSize: 12 }, tickLine: false };

// Horizontal bars: one hue (magnitude), names on the left, values at the bar ends.
function RankedBars({ data, format = money, domain, height, target }) {
  return (
    <ResponsiveContainer width="100%" height={height ?? Math.max(180, data.length * 30 + 40)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 72, left: 8, bottom: 4 }} barCategoryGap={6}>
        <CartesianGrid horizontal={false} stroke={INK.grid} />
        <XAxis type="number" {...axisProps} domain={domain} tickFormatter={format === money ? compactMoney : (v) => `${v}%`} />
        <YAxis type="category" dataKey="name" width={170} {...axisProps} axisLine={false} interval={0} />
        <Tooltip cursor={{ fill: "rgba(42,120,214,0.08)" }} content={<ValueTooltip format={format} />} />
        {target !== undefined && <ReferenceLine x={target} stroke={INK.muted} strokeDasharray="4 4" label={{ value: `target ${target}%`, fill: INK.muted, fontSize: 11, position: "top" }} />}
        <Bar
          dataKey="value"
          name="Value"
          fill={SEQUENTIAL}
          radius={[0, 4, 4, 0]}
          maxBarSize={18}
          label={{ position: "right", fill: "#52514e", fontSize: 12, formatter: (v) => (format === money ? compactMoney(v) : format(v)) }}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

// Donut for part-to-whole with few segments; every slice carries a visible label.
function Donut({ data, colors, format = money }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <ResponsiveContainer width="100%" height={280}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          innerRadius="55%"
          outerRadius="80%"
          paddingAngle={1}
          stroke="#fcfcfb"
          strokeWidth={2}
          label={({ name, value }) => `${name} ${total ? Math.round((value / total) * 100) : 0}%`}
          labelLine={{ stroke: INK.axis }}
          isAnimationActive={false}
        >
          {data.map((d, i) => <Cell key={d.name} fill={colors(d, i)} />)}
        </Pie>
        <Tooltip content={<ValueTooltip format={format} />} />
        <Legend iconType="square" wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

const Kpi = ({ label, value, note }) => (
  <div className="kpi">
    <div className="label">{label}</div>
    <div className="value">{value}</div>
    {note && <div className="muted">{note}</div>}
  </div>
);

export default function Reports() {
  const [preset, setPreset] = useState("90");
  const [range, setRange] = useState(() => {
    const to = new Date();
    return { from: isoDay(new Date(to.getTime() - 90 * 864e5)), to: isoDay(to) };
  });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const choosePreset = (value) => {
    setPreset(value);
    if (value !== "custom") {
      const to = new Date();
      setRange({ from: isoDay(new Date(to.getTime() - Number(value) * 864e5)), to: isoDay(to) });
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/reports/analytics", {
        params: { from: `${range.from}T00:00:00`, to: `${range.to}T23:59:59.999` },
      });
      setData(res.data);
      setError("");
    } catch (err) {
      setError(errorMessage(err, "Unable to load reports"));
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    load();
  }, [load]);

  const k = data?.kpis;
  const weekLabel = (w) => `Week of ${date(w)}`;

  return (
    <div className="page reports">
      <h2>Reports</h2>

      {/* One filter row scopes every number and chart on the page. */}
      <div className="toolbar">
        <select value={preset} onChange={(e) => choosePreset(e.target.value)} aria-label="Date range">
          {PRESETS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          <option value="custom">Custom range</option>
        </select>
        {preset === "custom" && (
          <>
            <label>From <input type="date" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
            <label>To <input type="date" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
          </>
        )}
        <button type="button" onClick={() => window.print()}>Print / PDF</button>
        {data && <span className="muted">{date(data.from)} – {date(data.to)}</span>}
      </div>

      {error && <p className="error">{error}</p>}
      {!data && !error && <p>Loading…</p>}

      {data && (
        <div style={{ opacity: loading ? 0.5 : 1, transition: "opacity 120ms" }}>
          <div className="kpis">
            <Kpi label="Purchases" value={money(k.purchasesValue)} note={`${k.purchaseOrders} purchase orders`} />
            <Kpi label="Issued to departments" value={money(k.issuesValue)} />
            <Kpi label="Waste" value={money(k.wasteValue)} note={k.wastePctOfIssues === null ? null : `${pct(k.wastePctOfIssues, 2)} of issues`} />
            <Kpi label="Stock value now" value={money(k.currentStockValue)} note={`avg ${money(k.averageStockValue)}`} />
            <Kpi label="Inventory turnover" value={k.inventoryTurnover === null ? "–" : `${num(k.inventoryTurnover)}×`} note="per year" />
            <Kpi label="Days of inventory" value={k.daysOfInventory === null ? "–" : `${num(k.daysOfInventory)} days`} />
            <Kpi label="Requisition fill rate" value={pct(k.requisitionFillRate)} note="quantity issued ÷ requested" />
            <Kpi label="Items to reorder" value={k.itemsToReorder} note="now" />
          </div>

          <div className="report-grid">
            <ChartCard
              wide
              title="Purchases vs issues by week"
              subtitle="Value of goods received and issued to departments (full weeks; the table also lists partial weeks and waste)"
              rows={data.weekly}
              columns={[
                { key: "week", label: "Week of", format: date },
                { key: "partial", label: "Partial week", format: (v) => (v ? "yes" : "") },
                { key: "purchases", label: "Purchases", numeric: true, format: money },
                { key: "issues", label: "Issues", numeric: true, format: money },
                { key: "waste", label: "Waste", numeric: true, format: money },
              ]}
            >
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={data.weekly.filter((w) => !w.partial)} margin={{ top: 8, right: 40, left: 8, bottom: 4 }}>
                  <CartesianGrid vertical={false} stroke={INK.grid} />
                  <XAxis dataKey="week" {...axisProps} tickFormatter={(w) => date(w)} minTickGap={24} />
                  <YAxis {...axisProps} axisLine={false} tickFormatter={compactMoney} width={72} />
                  <Tooltip content={<ValueTooltip labelFormat={weekLabel} />} cursor={{ stroke: INK.axis }} />
                  <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
                  <Line type="linear" dataKey="purchases" name="Purchases" stroke={SERIES[0]} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                  <Line type="linear" dataKey="issues" name="Issues" stroke={SERIES[1]} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard
              wide
              title="Central stock value"
              subtitle="Value of stock on hand in the central store at the end of each day"
              rows={data.stockValue}
              columns={[
                { key: "date", label: "Date", format: date },
                { key: "value", label: "Stock value", numeric: true, format: money },
              ]}
            >
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={data.stockValue} margin={{ top: 8, right: 40, left: 8, bottom: 4 }}>
                  <CartesianGrid vertical={false} stroke={INK.grid} />
                  <XAxis dataKey="date" {...axisProps} tickFormatter={(d) => date(d)} minTickGap={32} />
                  <YAxis {...axisProps} axisLine={false} tickFormatter={compactMoney} width={72} domain={[0, "auto"]} />
                  <Tooltip content={<ValueTooltip labelFormat={date} />} cursor={{ stroke: INK.axis }} />
                  <ReferenceLine y={k.averageStockValue} stroke={INK.muted} strokeDasharray="4 4" label={{ value: "average", fill: INK.muted, fontSize: 11, position: "insideTopRight" }} />
                  <Area type="linear" dataKey="value" name="Stock value" stroke={SEQUENTIAL} strokeWidth={2} fill={SEQUENTIAL} fillOpacity={0.12} />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard
              title="Issues by department"
              subtitle="Value issued from the central store"
              rows={data.byDepartment}
              columns={[
                { key: "name", label: "Department" },
                { key: "value", label: "Issued value", numeric: true, format: money },
              ]}
            >
              <RankedBars data={data.byDepartment} />
            </ChartCard>

            <ChartCard
              title="Consumption by category"
              subtitle="Share of issued value; smaller categories grouped as Other"
              rows={data.byCategory}
              columns={[
                { key: "name", label: "Category" },
                { key: "value", label: "Issued value", numeric: true, format: money },
              ]}
            >
              <Donut data={data.byCategory} colors={(d, i) => (d.name === "Other" ? OTHER : SERIES[i])} />
            </ChartCard>

            <ChartCard
              title="Spend by supplier"
              subtitle="Value of goods received"
              rows={data.spendByVendor}
              columns={[
                { key: "name", label: "Supplier" },
                { key: "value", label: "Received value", numeric: true, format: money },
              ]}
            >
              <RankedBars data={data.spendByVendor} />
            </ChartCard>

            <ChartCard
              title="Supplier delivery performance"
              subtitle="Last 180 days: on-time deliveries and share of ordered quantity received"
              rows={data.vendorPerformance}
              columns={[
                { key: "name", label: "Supplier" },
                { key: "onTime", label: "On-time %", numeric: true, format: (v) => pct(v) },
                { key: "fillRate", label: "Fill rate %", numeric: true, format: (v) => pct(v) },
                { key: "score", label: "Score", numeric: true, format: (v) => num(v) },
              ]}
            >
              <ResponsiveContainer width="100%" height={Math.max(220, data.vendorPerformance.length * 44 + 40)}>
                <BarChart data={data.vendorPerformance} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 4 }} barGap={2} barCategoryGap={10}>
                  <CartesianGrid horizontal={false} stroke={INK.grid} />
                  <XAxis type="number" domain={[0, 100]} {...axisProps} tickFormatter={(v) => `${v}%`} />
                  <YAxis type="category" dataKey="name" width={170} {...axisProps} axisLine={false} interval={0} />
                  <Tooltip cursor={{ fill: "rgba(42,120,214,0.08)" }} content={<ValueTooltip format={(v) => pct(v)} />} />
                  <Legend iconType="square" wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="onTime" name="On-time delivery" fill={SERIES[0]} radius={[0, 4, 4, 0]} maxBarSize={12} />
                  <Bar dataKey="fillRate" name="Fill rate" fill={SERIES[1]} radius={[0, 4, 4, 0]} maxBarSize={12} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard
              title="ABC analysis"
              subtitle="Share of annual consumption value by class (A = top 80%)"
              rows={data.abc}
              columns={[
                { key: "name", label: "Class" },
                { key: "items", label: "Items", numeric: true },
                { key: "value", label: "Annual consumption value", numeric: true, format: money },
              ]}
            >
              <Donut data={data.abc} colors={(d, i) => SERIES[i]} />
            </ChartCard>

            <ChartCard
              title="Stock status now"
              subtitle="Number of items in each status"
              rows={data.stockStatus}
              columns={[
                { key: "name", label: "Status" },
                { key: "value", label: "Items", numeric: true },
              ]}
            >
              <Donut data={data.stockStatus} colors={(d) => STATUS_COLORS[d.status]} format={(v) => `${v} items`} />
            </ChartCard>

            <ChartCard
              title="Top 10 items by consumption"
              subtitle="Highest issued value"
              rows={data.topConsumption}
              columns={[
                { key: "name", label: "Item" },
                { key: "quantity", label: "Quantity", numeric: true, format: (v) => num(v, 3) },
                { key: "unit", label: "Unit" },
                { key: "value", label: "Issued value", numeric: true, format: money },
              ]}
            >
              <RankedBars data={data.topConsumption} />
            </ChartCard>

            <ChartCard
              title="Top 10 waste items"
              subtitle="Value written off (central store and outlets)"
              rows={data.topWaste}
              columns={[
                { key: "name", label: "Item" },
                { key: "quantity", label: "Quantity", numeric: true, format: (v) => num(v, 3) },
                { key: "unit", label: "Unit" },
                { key: "value", label: "Waste value", numeric: true, format: money },
              ]}
            >
              <RankedBars data={data.topWaste} />
            </ChartCard>

            <ChartCard
              wide
              title="Requisition fill rate by department"
              subtitle="Quantity issued ÷ quantity requested on issued requisitions, lowest first"
              rows={data.fulfilment}
              columns={[
                { key: "name", label: "Department" },
                { key: "value", label: "Fill rate %", numeric: true, format: (v) => pct(v) },
              ]}
            >
              <RankedBars data={data.fulfilment} format={(v) => pct(v)} domain={[0, 100]} target={95} />
            </ChartCard>
          </div>
        </div>
      )}
    </div>
  );
}
