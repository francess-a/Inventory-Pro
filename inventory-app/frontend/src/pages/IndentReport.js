import React, { useCallback, useEffect, useState } from "react";
import { ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";
import api, { errorMessage } from "../services/api";
import { money, num, pct, date, departmentName, label } from "../utils/format";
import { SERIES, OTHER, INK, compactMoney, PRESETS, isoDay, axisProps, Kpi, ValueTooltip, ChartCard, RankedBars, Donut } from "../components/ReportKit";

// What happened to each indented line.
const STATES = [
  ["FULL", "Received in full", SERIES[0]],
  ["SHORT", "Received short", SERIES[1]],
  ["REJECTED", "Rejected", SERIES[4]],
  ["WAITING", "Waiting for approval or issue", OTHER],
];
const STATE_LABEL = Object.fromEntries(STATES.map(([key, text]) => [key, text]));

const hours = (h) => (h === null || h === undefined ? "–" : h < 48 ? `${num(h)} h` : `${num(h / 24)} days`);

export default function IndentReport() {
  const [preset, setPreset] = useState("30");
  const [range, setRange] = useState(() => {
    const to = new Date();
    return { from: isoDay(new Date(to.getTime() - 30 * 864e5)), to: isoDay(to) };
  });
  const [departmentId, setDepartmentId] = useState("");
  const [status, setStatus] = useState("");
  const [departments, setDepartments] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.get("/departments").then((res) => setDepartments(res.data)).catch(() => setDepartments([]));
  }, []);

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
      const res = await api.get("/reports/indent-vs-received", {
        params: {
          from: `${range.from}T00:00:00`,
          to: `${range.to}T23:59:59.999`,
          outletDepartmentId: departmentId || undefined,
          status: status || undefined,
        },
      });
      setData(res.data);
      setError("");
    } catch (err) {
      setError(errorMessage(err, "Unable to load the report"));
    } finally {
      setLoading(false);
    }
  }, [range, departmentId, status]);

  useEffect(() => {
    load();
  }, [load]);

  const s = data?.summary;
  const stateRows = s ? STATES.map(([key, text]) => ({ key, name: text, value: s.states[key] })).filter((r) => r.value > 0) : [];

  return (
    <div className="page reports">
      <h2>Indent vs Received</h2>
      <p className="muted">
        What departments asked the store for (indented) against what they received, for requisitions raised in the
        period. Fill rate counts requisitions that are closed (issued or rejected); ones still waiting are shown separately.
      </p>

      <div className="toolbar">
        <select value={preset} onChange={(e) => choosePreset(e.target.value)} aria-label="Date range">
          {[["7", "Last 7 days"], ...PRESETS].map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          <option value="custom">Custom range</option>
        </select>
        {preset === "custom" && (
          <>
            <label>From <input type="date" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
            <label>To <input type="date" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
          </>
        )}
        <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} aria-label="Department">
          <option value="">All departments</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{departmentName(d)}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Requisition status">
          <option value="">All statuses</option>
          {["PENDING", "APPROVED", "ISSUED", "REJECTED"].map((st) => <option key={st} value={st}>{label(st)}</option>)}
        </select>
        {data && <span className="muted">{date(data.from)} – {date(data.to)}</span>}
      </div>

      {error && <p className="error">{error}</p>}
      {!data && !error && <p>Loading…</p>}

      {data && (
        <div style={{ opacity: loading ? 0.5 : 1, transition: "opacity 120ms" }}>
          <div className="kpis">
            <Kpi label="Indented" value={money(s.indentValue)} note={`${s.requisitions} requisitions · ${s.lines} lines`} />
            <Kpi label="Received" value={money(s.receivedValue)} note="issued by the store" />
            <Kpi label="Fill rate" value={pct(s.fillRateValue)} note="received ÷ indented, closed requisitions" />
            <Kpi label="Lines received in full" value={pct(s.linesInFullPct)} note={`${s.states.FULL} of ${s.lines - s.states.WAITING} closed lines`} />
            <Kpi label="Short-issued" value={money(s.shortValue)} note={`${s.states.SHORT} lines`} />
            <Kpi label="Rejected" value={money(s.rejectedValue)} note={`${s.states.REJECTED} lines`} />
            <Kpi label="Still waiting" value={money(s.waitingValue)} note={`${s.states.WAITING} lines pending or approved`} />
            <Kpi label="Request to issue" value={hours(s.avgTurnaroundHours)} note="average time" />
          </div>

          <div className="report-grid">
            <ChartCard
              wide
              title="Indent vs received by department"
              subtitle="Value requested by each department (grey) and what the store issued to it (blue)"
              rows={data.byDepartment}
              columns={[
                { key: "name", label: "Department" },
                { key: "requisitions", label: "Requisitions", numeric: true },
                { key: "indentValue", label: "Indented", numeric: true, format: money },
                { key: "receivedValue", label: "Received", numeric: true, format: money },
                { key: "shortValue", label: "Short-issued", numeric: true, format: money },
                { key: "rejectedValue", label: "Rejected", numeric: true, format: money },
                { key: "waitingValue", label: "Waiting", numeric: true, format: money },
                { key: "fillRateValue", label: "Fill rate", numeric: true, format: (v) => pct(v) },
                { key: "avgTurnaroundHours", label: "Request to issue", numeric: true, format: hours },
              ]}
            >
              <ResponsiveContainer width="100%" height={Math.max(260, data.byDepartment.length * 40 + 60)}>
                <BarChart data={data.byDepartment} layout="vertical" margin={{ top: 4, right: 72, left: 8, bottom: 4 }} barGap={2} barCategoryGap={8}>
                  <CartesianGrid horizontal={false} stroke={INK.grid} />
                  <XAxis type="number" {...axisProps} tickFormatter={compactMoney} />
                  <YAxis type="category" dataKey="name" width={170} {...axisProps} axisLine={false} interval={0} />
                  <Tooltip cursor={{ fill: "rgba(42,120,214,0.08)" }} content={<ValueTooltip />} />
                  <Legend iconType="square" wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="indentValue" name="Indented" fill={OTHER} radius={[0, 4, 4, 0]} maxBarSize={14} />
                  <Bar dataKey="receivedValue" name="Received" fill={SERIES[0]} radius={[0, 4, 4, 0]} maxBarSize={14}
                    label={{ position: "right", fill: "#52514e", fontSize: 11, formatter: (v) => compactMoney(v) }} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard
              title="Indent vs received by week"
              subtitle="By the week the requisition was raised (full weeks)"
              rows={data.weekly}
              columns={[
                { key: "week", label: "Week of", format: date },
                { key: "indentValue", label: "Indented", numeric: true, format: money },
                { key: "receivedValue", label: "Received", numeric: true, format: money },
              ]}
            >
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={data.weekly.filter((w) => !w.partial)} margin={{ top: 8, right: 40, left: 8, bottom: 4 }}>
                  <CartesianGrid vertical={false} stroke={INK.grid} />
                  <XAxis dataKey="week" {...axisProps} tickFormatter={(w) => date(w)} minTickGap={24} />
                  <YAxis {...axisProps} axisLine={false} tickFormatter={compactMoney} width={72} />
                  <Tooltip content={<ValueTooltip labelFormat={(w) => `Week of ${date(w)}`} />} cursor={{ stroke: INK.axis }} />
                  <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
                  <Line type="linear" dataKey="indentValue" name="Indented" stroke="#898781" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                  <Line type="linear" dataKey="receivedValue" name="Received" stroke={SERIES[0]} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard
              title="What happened to each line"
              subtitle="Indented lines by outcome"
              rows={stateRows}
              columns={[
                { key: "name", label: "Outcome" },
                { key: "value", label: "Lines", numeric: true },
              ]}
            >
              <Donut data={stateRows} colors={(d) => STATES.find(([key]) => key === d.key)[2]} format={(v) => `${v} lines`} />
            </ChartCard>

            <ChartCard
              wide
              title="Biggest shortfalls by item"
              subtitle="Value indented but not received (short-issued or rejected), largest first"
              rows={data.byItem}
              columns={[
                { key: "name", label: "Item" },
                { key: "category", label: "Category" },
                { key: "unit", label: "Unit" },
                { key: "requested", label: "Indented", numeric: true, format: (v) => num(v, 3) },
                { key: "received", label: "Received", numeric: true, format: (v) => num(v, 3) },
                { key: "shortQty", label: "Short", numeric: true, format: (v) => num(v, 3) },
                { key: "waitingQty", label: "Waiting", numeric: true, format: (v) => num(v, 3) },
                { key: "shortValue", label: "Short value", numeric: true, format: money },
                { key: "fillRateValue", label: "Fill rate", numeric: true, format: (v) => pct(v) },
              ]}
            >
              {data.byItem.some((i) => i.shortValue > 0) ? (
                <RankedBars data={data.byItem.filter((i) => i.shortValue > 0).slice(0, 15).map((i) => ({ name: i.name, value: i.shortValue }))} />
              ) : (
                <p className="muted empty">Every closed line was received in full.</p>
              )}
            </ChartCard>

            <ChartCard
              wide
              tableOnly
              scrollTable
              title="Requisition lines"
              subtitle={`Every indented line with what was received${data.totalLines > data.lines.length ? ` (newest ${data.lines.length} of ${data.totalLines})` : ""}`}
              rows={data.lines}
              columns={[
                { key: "requisitionNumber", label: "Requisition" },
                { key: "createdAt", label: "Raised", format: date },
                { key: "department", label: "Department" },
                { key: "requestedBy", label: "Requested by" },
                { key: "item", label: "Item" },
                { key: "requested", label: "Indented", numeric: true, format: (v) => num(v, 3) },
                { key: "received", label: "Received", numeric: true, format: (v) => num(v, 3) },
                { key: "unit", label: "Unit" },
                { key: "receivedValue", label: "Received value", numeric: true, format: money },
                { key: "state", label: "Outcome", format: (v) => STATE_LABEL[v] },
                { key: "issuedAt", label: "Issued", format: (v) => (v ? date(v) : "–") },
              ]}
            />
          </div>
        </div>
      )}
    </div>
  );
}
