import React, { useCallback, useEffect, useState } from "react";
import api, { errorMessage } from "../services/api";
import { money, date, label, qty } from "../utils/format";
import { useCanApprove } from "../utils/roles";

const STATUSES = ["DRAFT", "SENT", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"];
const emptyLine = () => ({ itemId: "", quantityOrdered: "", unitPrice: "" });

function NewPurchase({ vendors, items, onCreated, onError }) {
  const canApprove = useCanApprove();
  const [vendorId, setVendorId] = useState("");
  const [lines, setLines] = useState([emptyLine()]);
  const [direct, setDirect] = useState(false);
  const [invoiceNumber, setInvoiceNumber] = useState("");

  const setLine = (i, patch) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const pickItem = (i, itemId) => {
    const item = items.find((it) => it.id === itemId);
    setLine(i, { itemId, unitPrice: lines[i].unitPrice || (item ? Number(item.costPrice) || "" : "") });
  };

  const total = lines.reduce((sum, l) => sum + (Number(l.quantityOrdered) || 0) * (Number(l.unitPrice) || 0), 0);

  const submit = async (e) => {
    e.preventDefault();
    try {
      const body = { vendorId, items: lines.filter((l) => l.itemId), ...(direct && { invoiceNumber }) };
      const res = await api.post(direct ? "/purchase-orders/direct" : "/purchase-orders", body);
      setLines([emptyLine()]);
      setInvoiceNumber("");
      onCreated(res.data);
    } catch (err) {
      onError(errorMessage(err));
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h3>New purchase</h3>
      <div className="line-row">
        <label>
          Supplier
          <select required value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="">Select supplier…</option>
            {vendors.filter((v) => v.isActive).map((v) => (
              <option key={v.id} value={v.id}>{v.vendorName} ({v.leadTimeDays} d lead time)</option>
            ))}
          </select>
        </label>
        {canApprove && (
          <label>
            <span>
              <input type="checkbox" checked={direct} onChange={(e) => setDirect(e.target.checked)} /> Direct purchase (goods
              received now, no PO)
            </span>
            {direct && <input placeholder="Invoice / bill number" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />}
          </label>
        )}
      </div>
      {lines.map((line, i) => (
        <div className="line-row" key={i}>
          <label>
            Item
            <select required value={line.itemId} onChange={(e) => pickItem(i, e.target.value)}>
              <option value="">Select item…</option>
              {items.map((it) => (
                <option key={it.id} value={it.id}>{it.itemName} ({it.sku})</option>
              ))}
            </select>
          </label>
          <label>
            Quantity
            <input type="number" min="0" step="any" required value={line.quantityOrdered} onChange={(e) => setLine(i, { quantityOrdered: e.target.value })} />
          </label>
          <label>
            Unit price
            <input type="number" min="0" step="0.01" required value={line.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} />
          </label>
          <span>{money((Number(line.quantityOrdered) || 0) * (Number(line.unitPrice) || 0))}</span>
          {lines.length > 1 && (
            <button type="button" className="link" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button>
          )}
        </div>
      ))}
      <div className="toolbar">
        <button type="button" onClick={() => setLines([...lines, emptyLine()])}>+ Add line</button>
        <strong>Total {money(total)}</strong>
        <button type="submit" className="primary">{direct ? "Save & receive into stock" : "Create draft PO"}</button>
      </div>
    </form>
  );
}

function ReceiveForm({ po, onDone, onError }) {
  const [lines, setLines] = useState(
    po.items.map((l) => ({
      poItemId: l.id,
      outstanding: qty(Number(l.quantityOrdered) - Number(l.quantityReceived) - Number(l.quantityRejected)),
      quantityReceived: qty(Number(l.quantityOrdered) - Number(l.quantityReceived) - Number(l.quantityRejected)),
      quantityRejected: 0,
      rejectionReason: "",
      unitPrice: Number(l.unitPrice),
      batchNumber: "",
      expiryDate: "",
    }))
  );
  const [invoiceNumber, setInvoiceNumber] = useState(po.invoiceNumber || "");
  const [invoiceDate, setInvoiceDate] = useState("");
  const setLine = (i, patch) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const submit = async () => {
    try {
      await api.post(`/purchase-orders/${po.id}/receive`, {
        invoiceNumber: invoiceNumber || undefined,
        invoiceDate: invoiceDate || undefined,
        lines: lines
          .filter((l) => l.outstanding > 0)
          .map(({ outstanding, ...l }) => ({
            ...l,
            rejectionReason: l.rejectionReason || undefined,
            batchNumber: l.batchNumber || undefined,
            expiryDate: l.expiryDate || undefined,
          })),
      });
      onDone();
    } catch (err) {
      onError(errorMessage(err));
    }
  };

  return (
    <div className="card">
      <h4>Goods receipt – {po.poNumber}</h4>
      <table className="data">
        <thead>
          <tr>
            <th>Item</th>
            <th className="num">Outstanding</th>
            <th>Accepted</th>
            <th>Rejected</th>
            <th>Rejection reason</th>
            <th>Invoice price</th>
            <th title="Supplier batch / lot number; generated from the GRN number when blank">Batch no.</th>
            <th title="Defaults to receipt date + shelf life when blank">Expiry</th>
          </tr>
        </thead>
        <tbody>
          {po.items.map((item, i) => (
            <tr key={item.id}>
              <td>{item.item.itemName}</td>
              <td className="num">{lines[i].outstanding} {item.item.unitOfMeasure}</td>
              <td><input type="number" min="0" step="any" style={{ width: 90 }} value={lines[i].quantityReceived} disabled={!lines[i].outstanding} onChange={(e) => setLine(i, { quantityReceived: e.target.value })} /></td>
              <td><input type="number" min="0" step="any" style={{ width: 90 }} value={lines[i].quantityRejected} disabled={!lines[i].outstanding} onChange={(e) => setLine(i, { quantityRejected: e.target.value })} /></td>
              <td><input value={lines[i].rejectionReason} disabled={!Number(lines[i].quantityRejected)} onChange={(e) => setLine(i, { rejectionReason: e.target.value })} /></td>
              <td><input type="number" min="0" step="0.01" style={{ width: 100 }} value={lines[i].unitPrice} disabled={!lines[i].outstanding} onChange={(e) => setLine(i, { unitPrice: e.target.value })} /></td>
              <td><input style={{ width: 110 }} value={lines[i].batchNumber} disabled={!lines[i].outstanding} onChange={(e) => setLine(i, { batchNumber: e.target.value })} /></td>
              <td><input type="date" value={lines[i].expiryDate} disabled={!lines[i].outstanding} onChange={(e) => setLine(i, { expiryDate: e.target.value })} aria-label={`Expiry date for ${item.item.itemName}`} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="toolbar">
        <input placeholder="Invoice number" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />
        <label>Invoice date <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} /></label>
        <button type="button" className="primary" onClick={submit}>Post receipt</button>
        <button type="button" onClick={onDone}>Close</button>
      </div>
    </div>
  );
}

export default function Purchases() {
  const canApprove = useCanApprove();
  const [orders, setOrders] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState("");
  const [vendorFilter, setVendorFilter] = useState("");
  const [expanded, setExpanded] = useState(null);
  const [receiving, setReceiving] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [po, v, it] = await Promise.all([
        api.get("/purchase-orders", { params: { status: status || undefined, vendorId: vendorFilter || undefined } }),
        api.get("/vendors"),
        api.get("/items"),
      ]);
      setOrders(po.data);
      setVendors(v.data);
      setItems(it.data.filter((i) => i.isActive));
    } catch (err) {
      setError(errorMessage(err, "Unable to load purchase orders"));
    }
  }, [status, vendorFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (po, action) => {
    try {
      await api.post(`/purchase-orders/${po.id}/${action}`);
      setMessage(`${po.poNumber}: ${{ send: "sent to supplier", cancel: "cancelled", close: "closed short" }[action]}.`);
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="page">
      <h2>Purchases</h2>
      {error && <p className="error" onClick={() => setError("")}>{error}</p>}
      {message && <p className="notice">{message}</p>}

      <NewPurchase
        vendors={vendors}
        items={items}
        onError={setError}
        onCreated={(po) => {
          setMessage(`${po.poNumber} saved (${label(po.status)}).`);
          setError("");
          load();
        }}
      />

      {receiving && (
        <ReceiveForm
          key={receiving.id}
          po={receiving}
          onError={setError}
          onDone={() => {
            setReceiving(null);
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
        <select value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)}>
          <option value="">All suppliers</option>
          {vendors.map((v) => <option key={v.id} value={v.id}>{v.vendorName}</option>)}
        </select>
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>PO number</th>
              <th>Supplier</th>
              <th>Status</th>
              <th>Created</th>
              <th>Expected</th>
              <th>Received</th>
              <th className="num">Lines</th>
              <th className="num">Ordered value</th>
              <th className="num">Received value</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {orders.map((po) => (
              <React.Fragment key={po.id}>
                <tr className="clickable" onClick={() => setExpanded(expanded === po.id ? null : po.id)}>
                  <td>{po.poNumber}</td>
                  <td>{po.vendor.vendorName}</td>
                  <td><span className={`badge ${po.status}`}>{label(po.status)}</span></td>
                  <td>{date(po.createdAt)}</td>
                  <td>{date(po.expectedDeliveryAt)}</td>
                  <td>{date(po.receivedAt)}</td>
                  <td className="num">{po.items.length}</td>
                  <td className="num">{money(po.orderedValue)}</td>
                  <td className="num">{money(po.receivedValue)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {canApprove && po.status === "DRAFT" && <button type="button" className="link" onClick={() => act(po, "send")}>Send</button>}
                    {["SENT", "PARTIALLY_RECEIVED"].includes(po.status) && (
                      <button type="button" className="link" onClick={() => setReceiving(po)}>Receive</button>
                    )}
                    {canApprove && po.status === "PARTIALLY_RECEIVED" && (
                      <button
                        type="button"
                        className="link"
                        title="The rest will not be delivered: stop counting it as on order"
                        onClick={() => window.confirm(`Close ${po.poNumber} short? The undelivered balance will no longer count as on order.`) && act(po, "close")}
                      >
                        Close short
                      </button>
                    )}
                    {canApprove && ["DRAFT", "SENT"].includes(po.status) && (
                      <button type="button" className="link" onClick={() => act(po, "cancel")}>Cancel</button>
                    )}
                  </td>
                </tr>
                {expanded === po.id &&
                  po.items.map((l) => (
                    <tr key={l.id}>
                      <td />
                      <td colSpan={2}>{l.item.itemName}</td>
                      <td colSpan={3} className="muted">
                        ordered {l.quantityOrdered} · received {l.quantityReceived} · rejected {l.quantityRejected}
                        {l.rejectionReason ? ` (${l.rejectionReason})` : ""}
                      </td>
                      <td />
                      <td className="num">{money(l.unitPrice)} / {l.item.unitOfMeasure}</td>
                      <td className="num">{money(Number(l.unitPrice) * Number(l.quantityReceived))}</td>
                      <td />
                    </tr>
                  ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
