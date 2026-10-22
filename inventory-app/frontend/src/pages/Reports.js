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
  LabelList,
} from "recharts";
import api, { errorMessage } from "../services/api";
import { money, num, pct, date } from "../utils/format";
import {
  SERIES,
  OTHER,
  SEQUENTIAL,
  STATUS_COLORS,
  INK,
  compactMoney,
  PRESETS,
  isoDay,
  axisProps,
  Kpi,
  ValueTooltip,
  ChartCard,
  RankedBars,
  Donut,
} from "../components/ReportKit";


// Opening stock → closing stock bridge. Each step is a floating bar: an invisible base plus
// the visible change, so the eye follows the running total.
function CogsWaterfall({ cogs }) {
  const steps = [
    { name: "Opening stock", delta: cogs.opening, total: true },
    { name: "Purchases", delta: cogs.purchases },
    { name: "Issued", delta: -cogs.issues },
    { name: "Waste", delta: -cogs.waste },
    { name: "Adjustments", delta: cogs.adjustments },
    { name: "Revaluation", delta: -cogs.revaluation },
    { name: "Closing stock", delta: cogs.closing, total: true },
  ].filter((st) => st.total || Math.abs(st.delta) >= 0.01);
  let running = 0;
  const data = steps.map((st) => {
    if (st.total) {
      running = st.delta;
      return { name: st.name, base: 0, value: st.delta, kind: "total", label: st.delta, text: compactMoney(st.delta) };
    }
    const start = running;
    running += st.delta;
    const text = `${st.delta >= 0 ? "+" : "−"}${compactMoney(Math.abs(st.delta))}`;
    return { name: st.name, base: Math.min(start, running), value: Math.abs(st.delta), kind: st.delta >= 0 ? "up" : "down", label: st.delta, text };
  });
  const fills = { total: "#52514e", up: SERIES[0], down: SERIES[1] };
  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data} margin={{ top: 24, right: 24, left: 8, bottom: 4 }} barCategoryGap="25%">
        <CartesianGrid vertical={false} stroke={INK.grid} />
        <XAxis dataKey="name" {...axisProps} interval={0} />
        <YAxis {...axisProps} axisLine={false} tickFormatter={compactMoney} width={72} />
        <Tooltip
          cursor={{ fill: "rgba(42,120,214,0.08)" }}
          content={({ active, payload }) =>
            active && payload?.length ? (
              <div className="viz-tooltip">
                <div className="viz-tooltip-row">
                  <strong>{money(payload[0].payload.label)}</strong>
                  <span className="muted">{payload[0].payload.name}</span>
                </div>
              </div>
            ) : null
          }
        />
        <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
        <Bar dataKey="value" stackId="w" radius={[4, 4, 0, 0]} isAnimationActive={false}>
          {data.map((d) => <Cell key={d.name} fill={fills[d.kind]} />)}
          {/* Label each step with its own signed amount, not the running total. */}
          <LabelList dataKey="text" position="top" fill="#52514e" fontSize={12} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

const SEVERITY = {
  high: { label: "High", className: "OUT_OF_STOCK" },
  medium: { label: "Medium", className: "REORDER" },
  low: { label: "Low", className: "OK" },
};

const signedPct = (v) => (v === null || v === undefined ? "–" : `${v > 0 ? "+" : ""}${Number(v).toFixed(1)}%`);

// Department × category heat-map: one sequential hue, light (little) to dark (a lot).
const HEAT_RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
function Heatmap({ matrix }) {
  const max = Math.max(1, ...matrix.rows.flatMap((r) => r.values));
  const step = (v) => Math.min(HEAT_RAMP.length - 1, Math.floor((v / max) * HEAT_RAMP.length));
  return (
    <div className="table-wrap heatmap">
      <table className="data">
        <thead>
          <tr>
            <th>Department</th>
            {matrix.categories.map((c) => <th key={c} className="num">{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {matrix.rows.map((r) => (
            <tr key={r.name}>
              <td>{r.name}</td>
              {r.values.map((v, i) => {
                const s = step(v);
                return (
                  <td
                    key={matrix.categories[i]}
                    className="num heat-cell"
                    title={`${r.name} · ${matrix.categories[i]}: ${money(v)}`}
                    style={v > 0 ? { background: HEAT_RAMP[s], color: s >= 3 ? "#fff" : "#0b0b0b" } : undefined}
                  >
                    {v > 0 ? compactMoney(v) : "–"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="heat-legend muted">
        less
        {HEAT_RAMP.map((c) => <span key={c} style={{ background: c }} />)}
        more (up to {compactMoney(max)})
      </div>
    </div>
  );
}

const HORIZONS = [
  ["daily", "Daily actions", "What to do today, from current stock, orders, requisitions and this week's prices"],
  ["monthly", "Monthly improvements", "Supplier, price, waste and department changes from the selected period"],
];

function Suggestions({ insights, costPct, targetCostPct }) {
  const [horizon, setHorizon] = useState("daily");
  const [showAll, setShowAll] = useState(false);
  const extra =
    costPct !== null && costPct > targetCostPct
      ? [{
          horizon: "monthly",
          severity: "high",
          category: "Cost of goods",
          title: `Cost of goods is ${pct(costPct)} of revenue, above the ${targetCostPct}% target`,
          detail: "Measured as cost of goods ÷ the revenue entered for this period.",
          action: "Review recipe costing and portion sizes for the highest-consumption items, act on the price suggestions, and cut waste.",
          impact: null,
        }]
      : [];
  const all = [...extra, ...insights];
  const list = all.filter((i) => i.horizon === horizon).slice(0, 20);
  const shown = showAll ? list : list.slice(0, 8);
  const [, , description] = HORIZONS.find(([key]) => key === horizon);
  return (
    <section className="card insights">
      <header className="report-card-head">
        <div>
          <h3>Top 20 actionable suggestions</h3>
          <p className="muted">
            {description}. Money figures are estimates at current usage; market trends are as current as the prices recorded.
          </p>
        </div>
      </header>
      <div className="tabs" role="tablist">
        {HORIZONS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={horizon === key}
            className={horizon === key ? "tab active" : "tab"}
            onClick={() => {
              setHorizon(key);
              setShowAll(false);
            }}
          >
            {label} ({Math.min(20, all.filter((i) => i.horizon === key).length)})
          </button>
        ))}
      </div>
      {list.length === 0 ? (
        <p className="muted empty">Nothing needs attention.</p>
      ) : (
        <ol className="insight-list">
          {shown.map((i, n) => (
            <li key={n} className="insight">
              <div className="insight-head">
                <span className="insight-rank">{n + 1}</span>
                <span className={`badge ${SEVERITY[i.severity].className}`}>{SEVERITY[i.severity].label}</span>
                <span className="muted">{i.category}</span>
                {i.impact !== null && i.impact !== undefined && (
                  <span className="insight-impact">
                    <strong>{money(i.impact)}</strong> <span className="muted">{i.impactLabel}</span>
                  </span>
                )}
              </div>
              <div className="insight-title">{i.title}</div>
              <div className="muted">{i.detail}</div>
              <div><strong>Action:</strong> {i.action}</div>
            </li>
          ))}
        </ol>
      )}
      {list.length > 8 && (
        <button type="button" className="link" onClick={() => setShowAll(!showAll)}>
          {showAll ? "Show fewer" : `Show all ${list.length}`}
        </button>
      )}
    </section>
  );
}

export default function Reports() {
  const [preset, setPreset] = useState("90");
  const [range, setRange] = useState(() => {
    const to = new Date();
    return { from: isoDay(new Date(to.getTime() - 90 * 864e5)), to: isoDay(to) };
  });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revenue, setRevenue] = useState("");
  const [targetCostPct, setTargetCostPct] = useState(30);

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
  const costPct = k && Number(revenue) > 0 ? (k.cogs / Number(revenue)) * 100 : null;
  const weekLabel = (w) => `Week of ${date(w)}`;
  const prevComplete = Boolean(data?.previousPeriod?.complete);
  const spendColumns = [
    { key: "name", label: "Item" },
    { key: "category", label: "Category" },
    { key: "quantity", label: "Quantity", numeric: true, format: (v) => num(v, 3) },
    { key: "unit", label: "Unit" },
    { key: "avgPrice", label: "Avg price", numeric: true, format: money },
    { key: "value", label: "Spend", numeric: true, format: money },
    { key: "sharePct", label: "Share", numeric: true, format: (v) => pct(v) },
    { key: "cumulativePct", label: "Cumulative", numeric: true, format: (v) => pct(v) },
    { key: "suppliers", label: "Suppliers", numeric: true },
    { key: "previous", label: "Previous period", numeric: true, format: money },
    { key: "changePct", label: "Change", numeric: true, format: signedPct },
  ];
  const deptColumns = [
    { key: "name", label: "Department" },
    { key: "current", label: "Issued", numeric: true, format: money },
    { key: "previous", label: "Previous period", numeric: true, format: money },
    { key: "changePct", label: "Change", numeric: true, format: signedPct },
    { key: "sharePct", label: "Share", numeric: true, format: (v) => pct(v) },
    { key: "perDay", label: "Per day", numeric: true, format: money },
    { key: "requisitions", label: "Requisitions", numeric: true },
    { key: "avgRequisition", label: "Avg requisition", numeric: true, format: money },
    { key: "fillRate", label: "Fill rate", numeric: true, format: (v) => pct(v) },
    { key: "outletWaste", label: "Waste in outlet", numeric: true, format: money },
  ];
  const heatRows = data
    ? data.departmentCategory.rows.map((r) => ({
        name: r.name,
        ...Object.fromEntries(data.departmentCategory.categories.map((c, i) => [c, r.values[i]])),
      }))
    : [];

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
            <Kpi label="Opening stock" value={money(k.openingStockValue)} note={`on ${date(data.from)}`} />
            <Kpi label="+ Purchases" value={money(k.purchasesValue)} note={`${k.purchaseOrders} purchase orders`} />
            <Kpi label="− Closing stock" value={money(k.closingStockValue)} note={`on ${date(data.to)}`} />
            <Kpi label="= Cost of goods (COGS)" value={money(k.cogs)} note="opening + purchases − closing" />
            <Kpi label="COGS ratio" value={pct(k.consumptionRatio)} note="COGS ÷ goods available (opening + purchases)" />
            <Kpi label="Cost of goods % of revenue" value={costPct === null ? "–" : pct(costPct)} note={`target ${targetCostPct}%`}>
              <div className="kpi-inputs">
                <label>
                  Revenue for the period
                  <input type="number" min="0" step="any" value={revenue} placeholder="enter revenue" onChange={(e) => setRevenue(e.target.value)} />
                </label>
                <label>
                  Target %
                  <input type="number" min="1" max="100" value={targetCostPct} onChange={(e) => setTargetCostPct(Number(e.target.value) || 30)} />
                </label>
              </div>
            </Kpi>
            <Kpi label="Issued to departments" value={money(k.issuesValue)} />
            <Kpi label="Waste" value={money(k.wasteValue)} note={k.wastePctOfIssues === null ? null : `${pct(k.wastePctOfIssues, 2)} of issues`} />
            <Kpi label="Inventory turnover" value={k.inventoryTurnover === null ? "–" : `${num(k.inventoryTurnover)}×`} note="per year" />
            <Kpi label="Days of inventory" value={k.daysOfInventory === null ? "–" : `${num(k.daysOfInventory)} days`} />
            <Kpi label="Requisition fill rate" value={pct(k.requisitionFillRate)} note="quantity issued ÷ requested" />
            <Kpi label="Non-moving stock" value={money(k.nonMovingValue)} note="no issues in the period" />
          </div>

          <Suggestions insights={data.insights} costPct={costPct} targetCostPct={targetCostPct} />

          <div className="report-grid">
            <div className="report-section">
              <h3>Cost of goods</h3>
              <p className="muted">Opening stock, purchases, closing stock and what was consumed</p>
            </div>

            <ChartCard
              wide
              title="Cost of goods: opening to closing stock"
              subtitle="How opening stock plus purchases became closing stock; issued, waste and adjustments make up the cost of goods"
              rows={[
                { step: "Opening stock", value: data.cogs.opening },
                { step: "+ Purchases", value: data.cogs.purchases },
                { step: "− Issued to departments", value: data.cogs.issues },
                { step: "− Waste (central store)", value: data.cogs.waste },
                { step: "± Stock adjustments", value: data.cogs.adjustments },
                { step: "± Revaluation / rounding", value: -data.cogs.revaluation },
                { step: "= Closing stock", value: data.cogs.closing },
                { step: "Cost of goods (opening + purchases − closing)", value: data.cogs.cogs },
              ]}
              columns={[
                { key: "step", label: "Step" },
                { key: "value", label: "Value", numeric: true, format: money },
              ]}
            >
              <CogsWaterfall cogs={data.cogs} />
            </ChartCard>

            <ChartCard
              wide
              tableOnly
              title="Cost of goods by category"
              subtitle="Stock movement statement; COGS ratio = COGS ÷ (opening + purchases)"
              rows={[...data.cogsByCategory, data.cogs]}
              columns={[
                { key: "name", label: "Category" },
                { key: "opening", label: "Opening", numeric: true, format: money },
                { key: "purchases", label: "Purchases", numeric: true, format: money },
                { key: "issues", label: "Issued", numeric: true, format: money },
                { key: "waste", label: "Waste", numeric: true, format: money },
                { key: "adjustments", label: "Adjustments", numeric: true, format: money },
                { key: "closing", label: "Closing", numeric: true, format: money },
                { key: "cogs", label: "COGS", numeric: true, format: money },
                { key: "consumptionRatio", label: "COGS ratio", numeric: true, format: (v) => pct(v) },
              ]}
            />

            <div className="report-section">
              <h3>Purchasing & spend</h3>
              <p className="muted">Where the money goes and how suppliers perform</p>
            </div>

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
              title="Top 30 items by purchase spend"
              subtitle="Highest value of goods received in the period"
              rows={data.topSpend}
              columns={spendColumns}
            >
              <RankedBars data={data.topSpend} />
            </ChartCard>

            <ChartCard
              title="30 items with the lowest purchase spend"
              subtitle={`Lowest value received among items bought in the period${
                data.noPurchaseItems ? `; ${data.noPurchaseItems} more item${data.noPurchaseItems > 1 ? "s" : ""} had no purchases` : ""
              }`}
              rows={data.leastSpend}
              columns={spendColumns}
            >
              <RankedBars data={data.leastSpend} />
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

            <div className="report-section">
              <h3>Departments</h3>
              <p className="muted">Department-wise comparison of consumption, growth and service</p>
            </div>

            <ChartCard
              wide
              title="Department comparison: this period vs previous"
              subtitle={
                prevComplete
                  ? `Value issued to each department, ${date(data.previousPeriod.from)} – ${date(data.previousPeriod.to)} shown in grey for comparison`
                  : "Value issued to each department (no comparison: the system has no data for the whole previous period yet)"
              }
              rows={data.departmentComparison}
              columns={deptColumns}
            >
              <ResponsiveContainer width="100%" height={Math.max(260, data.departmentComparison.length * (prevComplete ? 40 : 28) + 60)}>
                <BarChart data={data.departmentComparison} layout="vertical" margin={{ top: 4, right: 72, left: 8, bottom: 4 }} barGap={2} barCategoryGap={8}>
                  <CartesianGrid horizontal={false} stroke={INK.grid} />
                  <XAxis type="number" {...axisProps} tickFormatter={compactMoney} />
                  <YAxis type="category" dataKey="name" width={170} {...axisProps} axisLine={false} interval={0} />
                  <Tooltip cursor={{ fill: "rgba(42,120,214,0.08)" }} content={<ValueTooltip />} />
                  {prevComplete && <Legend iconType="square" wrapperStyle={{ fontSize: 12 }} />}
                  <Bar dataKey="current" name="This period" fill={SERIES[0]} radius={[0, 4, 4, 0]} maxBarSize={14}
                    label={{ position: "right", fill: "#52514e", fontSize: 11, formatter: (v) => compactMoney(v) }} />
                  {prevComplete && <Bar dataKey="previous" name="Previous period" fill={OTHER} radius={[0, 4, 4, 0]} maxBarSize={14} />}
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard
              wide
              tableOnly
              title="Department scorecard"
              subtitle="Consumption, growth, share, requisitions, fill rate and waste written off inside each department"
              rows={data.departmentComparison}
              columns={deptColumns}
            />

            <ChartCard
              wide
              title="What each department consumes"
              subtitle="Issued value by department and category; darker = more"
              rows={heatRows}
              columns={[{ key: "name", label: "Department" }, ...data.departmentCategory.categories.map((c) => ({ key: c, label: c, numeric: true, format: money }))]}
            >
              <Heatmap matrix={data.departmentCategory} />
            </ChartCard>

            <ChartCard
              wide
              title="Weekly issues by outlet"
              subtitle="Value issued per week to each main outlet (full weeks)"
              rows={data.weeklyByOutlet.rows}
              columns={[{ key: "week", label: "Week of", format: date }, ...data.weeklyByOutlet.outlets.map((o) => ({ key: o, label: o, numeric: true, format: money }))]}
            >
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={data.weeklyByOutlet.rows.filter((w) => !w.partial)} margin={{ top: 8, right: 40, left: 8, bottom: 4 }}>
                  <CartesianGrid vertical={false} stroke={INK.grid} />
                  <XAxis dataKey="week" {...axisProps} tickFormatter={(w) => date(w)} minTickGap={24} />
                  <YAxis {...axisProps} axisLine={false} tickFormatter={compactMoney} width={72} />
                  <Tooltip content={<ValueTooltip labelFormat={(w) => `Week of ${date(w)}`} />} cursor={{ stroke: INK.axis }} />
                  <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
                  {data.weeklyByOutlet.outlets.slice(0, SERIES.length).map((o, i) => (
                    <Line key={o} type="linear" dataKey={o} name={o} stroke={SERIES[i]} strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
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

            <div className="report-section">
              <h3>Stock</h3>
              <p className="muted">Stock value, status and how items move</p>
            </div>

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
              title="Fast, slow and non-moving items"
              subtitle="Number of items by movement class (fast = stock turns at least weekly)"
              rows={data.fsnSummary}
              columns={[
                { key: "name", label: "Class" },
                { key: "items", label: "Items", numeric: true },
                { key: "value", label: "Closing stock value", numeric: true, format: money },
              ]}
            >
              <Donut
                data={data.fsnSummary.filter((f) => f.items > 0).map((f) => ({ ...f, value: f.items }))}
                colors={(d) => ({ F: SERIES[0], S: SERIES[3], N: SERIES[1] })[d.fsn]}
                format={(v) => `${v} items`}
              />
            </ChartCard>

            <ChartCard
              title="Top 25 non-moving items"
              subtitle="No issues in the period, by stock value tied up"
              rows={data.nonMoving}
              columns={[
                { key: "name", label: "Item" },
                { key: "category", label: "Category" },
                { key: "closingQty", label: "On hand", numeric: true, format: (v) => num(v, 3) },
                { key: "unit", label: "Unit" },
                { key: "closingValue", label: "Value", numeric: true, format: money },
                { key: "lastIssue", label: "Last issued", format: (v) => (v ? date(v) : "never") },
                { key: "daysSinceIssue", label: "Days since issue", numeric: true, format: (v) => (v === null ? "–" : v) },
              ]}
            >
              <RankedBars data={data.nonMoving.map((m) => ({ name: m.name, value: m.closingValue }))} />
            </ChartCard>

            <ChartCard
              wide
              title="Top 25 fast-moving items"
              subtitle="Ranked by stock turnover (quantity issued ÷ average quantity on hand), shown as turns per year"
              rows={data.fastMoving}
              columns={[
                { key: "name", label: "Item" },
                { key: "category", label: "Category" },
                { key: "annualTurnover", label: "Turns / year", numeric: true, format: (v) => (v === null ? "–" : num(v)) },
                { key: "issuedQty", label: "Issued", numeric: true, format: (v) => num(v, 3) },
                { key: "unit", label: "Unit" },
                { key: "issueCount", label: "Issues", numeric: true },
                { key: "avgDailyUsage", label: "Avg / day", numeric: true, format: (v) => num(v, 2) },
                { key: "daysOfCover", label: "Days of cover", numeric: true, format: (v) => (v === null ? "–" : num(v)) },
                { key: "issuedValue", label: "Issued value", numeric: true, format: money },
              ]}
            >
              <RankedBars
                data={data.fastMoving.map((m) => ({ name: m.name, value: m.annualTurnover ?? 0 }))}
                format={(v) => `${num(v)}×`}
              />
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
          </div>
        </div>
      )}
    </div>
  );
}
