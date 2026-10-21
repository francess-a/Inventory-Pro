// Shared building blocks for report pages: palette, chart card with table view and CSV export,
// tooltip, ranked bars, donut and KPI tile.
import React, { useState } from "react";
import { ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine } from "recharts";
import { money } from "../utils/format";

// Categorical slots in fixed order (validated for colour-vision deficiency); never cycled.
export const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"];
export const OTHER = "#b4b2a9";
export const SEQUENTIAL = "#2a78d6";
// Status colours are reserved for stock status and always shown with a text label.
export const STATUS_COLORS = {
  OUT_OF_STOCK: "#d03b3b",
  BELOW_SAFETY_STOCK: "#ec835a",
  REORDER: "#fab219",
  OK: "#0ca30c",
  OVERSTOCK: "#898781",
};
export const INK = { muted: "#898781", grid: "#e1e0d9", axis: "#c3c2b7" };

export const compactMoney = (value) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: process.env.REACT_APP_CURRENCY || "INR",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);

export const PRESETS = [
  ["30", "Last 30 days"],
  ["90", "Last 90 days"],
  ["180", "Last 180 days"],
  ["365", "Last 12 months"],
];

export const isoDay = (d) => d.toISOString().slice(0, 10);

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
export function ValueTooltip({ active, payload, label, format = money, labelFormat = (l) => l }) {
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

export function ChartCard({ title, subtitle, columns, rows, wide, tableOnly, scrollTable, children }) {
  const [showTable, setShowTable] = useState(Boolean(tableOnly));
  return (
    <section className={`card report-card${wide ? " wide" : ""}`}>
      <header className="report-card-head">
        <div>
          <h3>{title}</h3>
          {subtitle && <p className="muted">{subtitle}</p>}
        </div>
        <div className="report-card-actions">
          {!tableOnly && (
            <button type="button" className="link" onClick={() => setShowTable(!showTable)}>
              {showTable ? "Chart" : "Table"}
            </button>
          )}
          <button type="button" className="link" onClick={() => downloadCsv(title, columns, rows)} disabled={!rows.length}>
            CSV
          </button>
        </div>
      </header>
      {rows.length === 0 ? (
        <p className="muted empty">No data in this period.</p>
      ) : showTable ? (
        <div className={`table-wrap report-table${tableOnly && !scrollTable ? " full" : ""}`}>
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

export const axisProps = { stroke: INK.axis, tick: { fill: INK.muted, fontSize: 12 }, tickLine: false };

// Horizontal bars: one hue (magnitude), names on the left, values at the bar ends.
export function RankedBars({ data, format = money, domain, height, target }) {
  return (
    <ResponsiveContainer width="100%" height={height ?? Math.max(180, data.length * 30 + 40)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 72, left: 8, bottom: 4 }} barCategoryGap={6}>
        <CartesianGrid horizontal={false} stroke={INK.grid} />
        <XAxis type="number" {...axisProps} domain={domain} tickFormatter={format === money ? compactMoney : format} />
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
export function Donut({ data, colors, format = money }) {
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

export const Kpi = ({ label, value, note, children }) => (
  <div className="kpi">
    <div className="label">{label}</div>
    <div className="value">{value}</div>
    {note && <div className="muted">{note}</div>}
    {children}
  </div>
);
