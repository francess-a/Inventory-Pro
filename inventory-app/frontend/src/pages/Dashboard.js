import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import hotelApi, { errorMessage } from "../services/hotelApi";
import { money, departmentName } from "../utils/format";

const Kpi = ({ label, value, alert, to }) => (
  <div className={`kpi${alert ? " alert" : ""}`}>
    <div className="label">{to ? <Link to={to}>{label}</Link> : label}</div>
    <div className="value">{value}</div>
  </div>
);

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    hotelApi
      .get("/reports/dashboard")
      .then((res) => setData(res.data))
      .catch((err) => setError(errorMessage(err, "Unable to load dashboard")));
  }, []);

  if (error) return <div className="page"><p className="error">{error}</p></div>;
  if (!data) return <div className="page">Loading…</div>;

  const consumption = data.departmentConsumptionLast30Days.map((d) => ({
    name: departmentName(d.department),
    value: Number(d.totalValue),
  }));

  return (
    <div className="page">
      <h2>Central Store Dashboard</h2>
      <div className="kpis">
        <Kpi label="Central stock value" value={money(data.centralStockValue)} />
        <Kpi label="Active items" value={data.itemCount} to="/stock" />
        <Kpi label="Items to reorder" value={data.itemsToReorder} alert={data.itemsToReorder > 0} to="/stock" />
        <Kpi label="Suggested order value" value={money(data.suggestedOrderValue)} />
        <Kpi label="Out of stock" value={data.outOfStock} alert={data.outOfStock > 0} />
        <Kpi label="Below safety stock" value={data.belowSafetyStock} alert={data.belowSafetyStock > 0} />
        <Kpi label="Overstocked" value={data.overstock} />
        <Kpi label="Open purchase orders" value={data.openPurchaseOrders} to="/purchases" />
        <Kpi label="Requisitions to approve" value={data.pendingRequisitions} to="/requisitions" />
        <Kpi label="Requisitions to issue" value={data.approvedRequisitions} to="/requisitions" />
      </div>

      <section className="card">
        <h3>Issues by department – last 30 days</h3>
        <div style={{ width: "100%", height: 340 }}>
          <ResponsiveContainer>
            <BarChart data={consumption} margin={{ top: 10, right: 24, left: 24, bottom: 70 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" angle={-35} textAnchor="end" interval={0} height={80} />
              <YAxis tickFormatter={(v) => money(v)} width={100} />
              <Tooltip formatter={(v) => money(v)} />
              <Bar dataKey="value" name="Issued value" fill="#3538cd" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  );
}
