import React, { useCallback, useEffect, useState } from "react";
import api, { errorMessage } from "../services/api";
import { num, ratioPct, date, label } from "../utils/format";
import { useCanApprove } from "../utils/roles";

const COMPONENT_LABELS = { onTime: "On-time", fillRate: "Fill rate", quality: "Quality", price: "Price" };

const EMPTY_VENDOR = { vendorName: "", contactName: "", email: "", phone: "", leadTimeDays: 1 };

export default function Vendors() {
  const canApprove = useCanApprove();
  const [cards, setCards] = useState([]);
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState(EMPTY_VENDOR);
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api
      .get("/vendors/scorecards")
      .then((res) => setCards(res.data))
      .catch((err) => setError(errorMessage(err, "Unable to load vendors")));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openDetail = async (vendorId) => {
    if (detail?.vendor.id === vendorId) return setDetail(null);
    try {
      setDetail((await api.get(`/vendors/${vendorId}/scorecard`)).data);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const save = async (e) => {
    e.preventDefault();
    try {
      await api.post("/vendors", form);
      setForm(EMPTY_VENDOR);
      setShowAdd(false);
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const field = (name) => ({ value: form[name], onChange: (e) => setForm({ ...form, [name]: e.target.value }) });

  return (
    <div className="page">
      <h2>Vendor Scorecards</h2>
      <p className="muted">
        Last 180 days of deliveries. Score = 30% on-time delivery + 25% fill rate + 25% quality acceptance + 20% price
        (100 at or below the market benchmark, −2 points per 1% above it). Metrics with no data are left out and the
        remaining weights rescaled. Grades: A ≥ 85, B ≥ 70, C ≥ 55, D below.
      </p>
      {error && <p className="error">{error}</p>}
      {canApprove && (
        <div className="toolbar">
          <button type="button" onClick={() => setShowAdd(!showAdd)}>{showAdd ? "Close" : "Add vendor"}</button>
        </div>
      )}
      {canApprove && showAdd && (
        <form className="card form-grid" onSubmit={save}>
          <label>Vendor name<input required {...field("vendorName")} /></label>
          <label>Contact name<input required {...field("contactName")} /></label>
          <label>Email<input required type="email" {...field("email")} /></label>
          <label>Phone<input required {...field("phone")} /></label>
          <label>Promised lead time (days)<input required type="number" min="0" {...field("leadTimeDays")} /></label>
          <label>&nbsp;<button type="submit" className="primary">Save vendor</button></label>
        </form>
      )}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Vendor</th>
              <th>Grade</th>
              <th className="num">Score</th>
              <th className="num">Deliveries</th>
              <th className="num">Promised lead time</th>
              <th className="num">Actual lead time</th>
              <th className="num">On-time</th>
              <th className="num">Fill rate</th>
              <th className="num">Quality accepted</th>
              <th className="num" title="Vendor price ÷ market benchmark, weighted by quantity. 1.00 = market price.">Price index</th>
            </tr>
          </thead>
          <tbody>
            {cards.map((c) => (
              <React.Fragment key={c.vendor.id}>
                <tr className="clickable" onClick={() => openDetail(c.vendor.id)}>
                  <td>
                    {c.vendor.vendorName}
                    <div className="muted">{c.vendor.contactName} · {c.vendor.phone}</div>
                  </td>
                  <td>{c.grade ? <span className={`badge ${c.grade}`}>{c.grade}</span> : "–"}</td>
                  <td className="num">{num(c.overallScore)}</td>
                  <td className="num">{c.purchaseOrdersDelivered}</td>
                  <td className="num">{c.promisedLeadTimeDays} d</td>
                  <td className={`num ${c.avgActualLeadTimeDays > c.promisedLeadTimeDays + 0.5 ? "up" : ""}`}>
                    {c.avgActualLeadTimeDays === null ? "–" : `${num(c.avgActualLeadTimeDays)} d ± ${num(c.leadTimeStdDev)}`}
                  </td>
                  <td className="num">{ratioPct(c.onTimeDeliveryRate)}</td>
                  <td className="num">{ratioPct(c.fillRate)}</td>
                  <td className="num">{ratioPct(c.qualityAcceptanceRate)}</td>
                  <td className={`num ${c.priceIndex > 1.02 ? "up" : c.priceIndex !== null && c.priceIndex < 0.98 ? "down" : ""}`}>
                    {c.priceIndex === null ? "–" : c.priceIndex.toFixed(2)}
                  </td>
                </tr>
                {detail?.vendor.id === c.vendor.id && (
                  <tr>
                    <td colSpan={10}>
                      <div className="card">
                        <strong>Component scores:</strong>{" "}
                        {Object.entries(detail.componentScores)
                          .map(([k, v]) => `${COMPONENT_LABELS[k]} ${v === null ? "n/a" : num(v)}`)
                          .join(" · ")}
                        <table className="data" style={{ marginTop: 8 }}>
                          <thead>
                            <tr><th>PO</th><th>Status</th><th>Sent</th><th>Due</th><th>Received</th></tr>
                          </thead>
                          <tbody>
                            {detail.recentOrders.map((po) => {
                              const late = po.receivedAt && po.expectedDeliveryAt && new Date(po.receivedAt) > new Date(new Date(po.expectedDeliveryAt).getTime() + 432e5);
                              return (
                                <tr key={po.id}>
                                  <td>{po.poNumber}</td>
                                  <td><span className={`badge ${po.status}`}>{label(po.status)}</span></td>
                                  <td>{date(po.sentAt)}</td>
                                  <td>{date(po.expectedDeliveryAt)}</td>
                                  <td className={late ? "up" : ""}>{date(po.receivedAt)}{late ? " (late)" : ""}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
