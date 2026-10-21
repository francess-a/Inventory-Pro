import React, { useCallback, useEffect, useMemo, useState } from "react";
import hotelApi, { errorMessage } from "../services/hotelApi";
import { money, num, date, departmentName, label } from "../utils/format";
import { useCanApprove } from "../utils/roles";

const STATUSES = ["PENDING", "APPROVED", "ISSUED", "REJECTED"];
const emptyLine = () => ({ itemId: "", quantityRequested: "" });

function NewRequisition({ departments, items, onCreated, onError }) {
  const [outletDepartmentId, setDepartment] = useState("");
  const [requestedBy, setRequestedBy] = useState("");
  const [lines, setLines] = useState([emptyLine()]);
  const setLine = (i, patch) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const submit = async (e) => {
    e.preventDefault();
    try {
      const res = await hotelApi.post("/requisitions", {
        outletDepartmentId,
        requestedBy: requestedBy || undefined,
        items: lines.filter((l) => l.itemId),
      });
      setLines([emptyLine()]);
      onCreated(res.data);
    } catch (err) {
      onError(errorMessage(err));
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h3>New requisition</h3>
      <div className="line-row">
        <label>
          Department
          <select required value={outletDepartmentId} onChange={(e) => setDepartment(e.target.value)}>
            <option value="">Select department…</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{departmentName(d)}</option>)}
          </select>
        </label>
        <label>
          Requested by
          <input placeholder="defaults to your login" value={requestedBy} onChange={(e) => setRequestedBy(e.target.value)} />
        </label>
      </div>
      {lines.map((line, i) => {
        const item = items.find((it) => it.id === line.itemId);
        return (
          <div className="line-row" key={i}>
            <label>
              Item
              <select required value={line.itemId} onChange={(e) => setLine(i, { itemId: e.target.value })}>
                <option value="">Select item…</option>
                {items.map((it) => <option key={it.id} value={it.id}>{it.itemName} ({it.sku})</option>)}
              </select>
            </label>
            <label>
              Quantity
              <input type="number" min="0" step="any" required value={line.quantityRequested} onChange={(e) => setLine(i, { quantityRequested: e.target.value })} />
            </label>
            {item && (
              <span className="muted">
                in store: {num(item.centralStock?.quantityOnHand ?? 0, 3)} {item.unitOfMeasure} · est.{" "}
                {money(Number(item.costPrice) * (Number(line.quantityRequested) || 0))}
              </span>
            )}
            {lines.length > 1 && (
              <button type="button" className="link" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button>
            )}
          </div>
        );
      })}
      <div className="toolbar">
        <button type="button" onClick={() => setLines([...lines, emptyLine()])}>+ Add line</button>
        <button type="submit" className="primary">Submit requisition</button>
      </div>
    </form>
  );
}

function IssueForm({ requisition, stockByItem, onDone, onError }) {
  const [quantities, setQuantities] = useState(
    Object.fromEntries(
      requisition.items.map((l) => [l.id, Math.min(Number(l.quantityRequested), stockByItem.get(l.itemId) ?? 0)])
    )
  );

  const submit = async () => {
    try {
      await hotelApi.post(`/requisitions/${requisition.id}/issue`, {
        lines: Object.entries(quantities).map(([requisitionItemId, quantityIssued]) => ({
          requisitionItemId,
          quantityIssued: Number(quantityIssued) || 0,
        })),
      });
      onDone();
    } catch (err) {
      onError(errorMessage(err));
    }
  };

  return (
    <div className="card">
      <h4>Issue {requisition.requisitionNumber} to {departmentName(requisition.department)}</h4>
      <table className="data">
        <thead>
          <tr>
            <th>Item</th>
            <th className="num">Requested</th>
            <th className="num">In store</th>
            <th>Issue qty</th>
            <th className="num">Value @ avg cost</th>
          </tr>
        </thead>
        <tbody>
          {requisition.items.map((l) => (
            <tr key={l.id}>
              <td>{l.item.itemName}</td>
              <td className="num">{l.quantityRequested} {l.item.unitOfMeasure}</td>
              <td className="num">{stockByItem.get(l.itemId) ?? 0}</td>
              <td>
                <input type="number" min="0" step="any" max={l.quantityRequested} style={{ width: 90 }} value={quantities[l.id]}
                  onChange={(e) => setQuantities({ ...quantities, [l.id]: e.target.value })} />
              </td>
              <td className="num">{money(Number(l.item.costPrice) * (Number(quantities[l.id]) || 0))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="toolbar">
        <button type="button" className="primary" onClick={submit}>Issue from central store</button>
        <button type="button" onClick={onDone}>Close</button>
      </div>
    </div>
  );
}

function Consumption() {
  const [range, setRange] = useState({
    from: new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10),
    to: new Date().toISOString().slice(0, 10),
  });
  const [report, setReport] = useState(null);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    hotelApi
      .get("/reports/department-consumption", { params: { from: range.from, to: `${range.to}T23:59:59` } })
      .then((res) => setReport(res.data))
      .catch(() => setReport(null));
  }, [range]);

  return (
    <section className="card">
      <h3>Issues by department</h3>
      <div className="toolbar">
        <label>From <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
        <label>To <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
      </div>
      {report && (
        <table className="data">
          <thead>
            <tr><th>Department</th><th className="num">Issued value</th></tr>
          </thead>
          <tbody>
            {report.departments.map((d) => (
              <React.Fragment key={d.department.id}>
                <tr className="clickable" onClick={() => setOpen(open === d.department.id ? null : d.department.id)}>
                  <td>{departmentName(d.department)}</td>
                  <td className="num">{money(d.totalValue)}</td>
                </tr>
                {open === d.department.id &&
                  d.items.map((it) => (
                    <tr key={it.id}>
                      <td className="muted">&nbsp;&nbsp;{it.itemName} – {it.quantity} {it.unitOfMeasure}</td>
                      <td className="num muted">{money(it.value)}</td>
                    </tr>
                  ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default function Requisitions() {
  const canApprove = useCanApprove();
  const [requisitions, setRequisitions] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [issuing, setIssuing] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [reqs, depts, its] = await Promise.all([
        hotelApi.get("/requisitions", { params: { status: status || undefined, outletDepartmentId: departmentFilter || undefined } }),
        hotelApi.get("/departments"),
        hotelApi.get("/items"),
      ]);
      setRequisitions(reqs.data);
      setDepartments(depts.data);
      setItems(its.data.filter((i) => i.isActive));
    } catch (err) {
      setError(errorMessage(err, "Unable to load requisitions"));
    }
  }, [status, departmentFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const stockByItem = useMemo(() => new Map(items.map((i) => [i.id, Number(i.centralStock?.quantityOnHand ?? 0)])), [items]);

  const decide = async (req, action) => {
    try {
      await hotelApi.post(`/requisitions/${req.id}/${action}`, {});
      setMessage(`${req.requisitionNumber} ${action === "approve" ? "approved" : "rejected"}.`);
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="page">
      <h2>Requisitions &amp; Issues</h2>
      {error && <p className="error" onClick={() => setError("")}>{error}</p>}
      {message && <p className="notice">{message}</p>}

      <NewRequisition
        departments={departments}
        items={items}
        onError={setError}
        onCreated={(r) => {
          setMessage(`${r.requisitionNumber} submitted.`);
          setError("");
          load();
        }}
      />

      {issuing && (
        <IssueForm
          key={issuing.id}
          requisition={issuing}
          stockByItem={stockByItem}
          onError={setError}
          onDone={() => {
            setIssuing(null);
            setError("");
            load();
          }}
        />
      )}

      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </select>
        <select value={departmentFilter} onChange={(e) => setDepartmentFilter(e.target.value)}>
          <option value="">All departments</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{departmentName(d)}</option>)}
        </select>
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Number</th>
              <th>Department</th>
              <th>Status</th>
              <th>Requested by</th>
              <th>Created</th>
              <th>Issued</th>
              <th className="num">Lines</th>
              <th className="num">Est. value</th>
              <th className="num">Issued value</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {requisitions.map((r) => (
              <React.Fragment key={r.id}>
                <tr className="clickable" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                  <td>{r.requisitionNumber}</td>
                  <td>{departmentName(r.department)}</td>
                  <td><span className={`badge ${r.status}`}>{label(r.status)}</span></td>
                  <td>{r.requestedBy}</td>
                  <td>{date(r.createdAt)}</td>
                  <td>{date(r.issuedAt)}</td>
                  <td className="num">{r.items.length}</td>
                  <td className="num">{money(r.estimatedValue)}</td>
                  <td className="num">{r.status === "ISSUED" ? money(r.issuedValue) : ""}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {canApprove && r.status === "PENDING" && (
                      <>
                        <button type="button" className="link" onClick={() => decide(r, "approve")}>Approve</button>
                        <button type="button" className="link" onClick={() => decide(r, "reject")}>Reject</button>
                      </>
                    )}
                    {r.status === "APPROVED" && (
                      <button type="button" className="link" onClick={() => setIssuing(r)}>Issue</button>
                    )}
                  </td>
                </tr>
                {expanded === r.id &&
                  r.items.map((l) => (
                    <tr key={l.id}>
                      <td />
                      <td colSpan={3}>{l.item.itemName}</td>
                      <td colSpan={3} className="muted">
                        requested {l.quantityRequested} · issued {l.quantityIssued} {l.item.unitOfMeasure}
                      </td>
                      <td className="num muted">{l.unitCost ? `${money(l.unitCost)} / ${l.item.unitOfMeasure}` : ""}</td>
                      <td className="num">{Number(l.quantityIssued) ? money(l.issuedValue) : ""}</td>
                      <td />
                    </tr>
                  ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <Consumption />
    </div>
  );
}
