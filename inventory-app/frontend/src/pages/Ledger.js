import React, { useCallback, useEffect, useState } from "react";
import { useSelector } from "react-redux";
import api, { errorMessage } from "../services/api";
import { money, num, date, label } from "../utils/format";

const short = (hash) => (hash ? `${hash.slice(0, 10)}…` : "");
const when = (value) => (value ? new Date(value).toLocaleString() : "–");

const TABS = [
  ["ledger", "Stock ledger"],
  ["inward", "Goods received"],
  ["issues", "Issues to outlets"],
  ["batches", "Batches & expiry"],
  ["audit", "API audit log"],
];

function Table({ columns, rows, empty = "Nothing to show." }) {
  if (!rows.length) return <p className="muted empty">{empty}</p>;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>{columns.map(([key, text, numeric]) => <th key={key} className={numeric ? "num" : ""}>{text}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id ?? i}>
              {columns.map(([key, , numeric, format]) => (
                <td key={key} className={numeric ? "num" : ""}>{format ? format(r[key], r) : r[key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Verification() {
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const verify = async () => {
    setBusy(true);
    try {
      setReport((await api.get("/ledger/verify")).data);
      setError("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const downloadHeads = () => {
    const blob = new Blob([JSON.stringify({ verifiedAt: report.verifiedAt, heads: report.heads }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ledger-heads-${report.verifiedAt.slice(0, 10)}.json`;
    a.click();
  };
  return (
    <section className="card">
      <h3>Ledger integrity</h3>
      <p className="muted">
        Every stock movement is written once and can never be edited or deleted. Each entry carries a SHA-256 hash of its
        contents and of the previous entry for the same item, so changing any past row breaks the chain. Verification
        recomputes every hash and checks the last balance against current stock and stock batches.
      </p>
      <div className="toolbar">
        <button type="button" className="primary" onClick={verify} disabled={busy}>{busy ? "Verifying…" : "Verify ledger"}</button>
        {report && <button type="button" onClick={downloadHeads}>Download chain heads</button>}
      </div>
      {error && <p className="error">{error}</p>}
      {report && (
        <>
          <p className={report.valid ? "notice" : "error"}>
            {report.valid
              ? `Verified ${num(report.entries, 0)} entries across ${report.items} items: every hash and balance matches.`
              : `${report.problems.length} problem(s) found in ${num(report.entries, 0)} entries.`}
          </p>
          {!report.valid && (
            <Table
              rows={report.problems}
              columns={[
                ["sku", "Item"],
                ["seq", "Entry #", true],
                ["problem", "Problem", false, label],
                ["detail", "Detail"],
              ]}
            />
          )}
        </>
      )}
    </section>
  );
}

export default function Ledger() {
  const role = useSelector((state) => state.auth.user?.role);
  const [tab, setTab] = useState("ledger");
  const [items, setItems] = useState([]);
  const [itemId, setItemId] = useState("");
  const [expiringWithinDays, setExpiringWithinDays] = useState("7");
  // Rows are kept with the tab they were fetched for, so a tab switch never renders
  // the previous tab's rows with the new tab's columns.
  const [data, setData] = useState({ tab: null, rows: [], next: null });
  const [error, setError] = useState("");

  useEffect(() => {
    api.get("/items").then((res) => setItems(res.data)).catch(() => setItems([]));
  }, []);

  const fetchTab = useCallback(
    async (cursor) => {
      const params = { itemId: itemId || undefined, limit: 100 };
      if (tab === "ledger") {
        const res = await api.get("/ledger/transactions", { params: { ...params, beforeSeq: cursor } });
        return { rows: res.data.rows, next: res.data.rows.length === 100 ? res.data.nextBeforeSeq : null };
      }
      if (tab === "audit") {
        const res = await api.get("/audit/log", { params: { limit: 100, beforeId: cursor } });
        return { rows: res.data.rows, next: res.data.rows.length === 100 ? res.data.nextBeforeId : null };
      }
      if (tab === "batches") {
        const res = await api.get("/ledger/batches", { params: { itemId: itemId || undefined, expiringWithinDays: expiringWithinDays || undefined } });
        return { rows: res.data, next: null };
      }
      const res = await api.get(tab === "inward" ? "/ledger/inward" : "/ledger/issues", { params });
      return { rows: res.data, next: null };
    },
    [tab, itemId, expiringWithinDays]
  );

  useEffect(() => {
    let current = true;
    fetchTab()
      .then((r) => {
        if (!current) return;
        setData({ tab, rows: r.rows, next: r.next });
        setError("");
      })
      .catch((err) => current && setError(errorMessage(err)));
    return () => {
      current = false;
    };
  }, [fetchTab, tab]);

  const more = async () => {
    try {
      const r = await fetchTab(data.next);
      setData({ tab, rows: [...data.rows, ...r.rows], next: r.next });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const columns = {
    ledger: [
      ["seq", "#", true],
      ["timestamp", "Time", false, when],
      ["item", "Item", false, (v) => v.itemName],
      ["type", "Type", false, label],
      ["quantity", "Qty", true, (v, r) => `${num(v, 3)} ${r.item.unitOfMeasure}`],
      ["unitCost", "Unit cost", true, money],
      ["transactionValue", "Value", true, money],
      ["closingStockCentral", "Closing qty", true, (v) => num(v, 3)],
      ["closingStockCentralValue", "Closing value", true, money],
      ["remarks", "Reference"],
      ["createdBy", "By"],
      ["entryHash", "Hash", false, (v) => <code title={v}>{short(v)}</code>],
    ],
    inward: [
      ["receivedAt", "Received", false, when],
      ["grnNumber", "GRN"],
      ["purchaseOrder", "PO", false, (v) => v.poNumber],
      ["vendor", "Vendor", false, (v) => v.vendorName],
      ["item", "Item", false, (v) => v.itemName],
      ["batchNumber", "Batch"],
      ["expiryDate", "Expiry", false, date],
      ["quantityReceived", "Accepted", true, (v, r) => `${num(v, 3)} ${r.unitOfMeasure}`],
      ["quantityRejected", "Rejected", true, (v, r) => (Number(v) ? `${num(v, 3)} (${r.rejectionReason})` : "")],
      ["unitPrice", "Price", true, money],
      ["lineValue", "Value", true, money],
      ["invoiceNumber", "Invoice"],
      ["invoiceDate", "Invoice date", false, date],
      ["receivedBy", "By"],
    ],
    issues: [
      ["issuedAt", "Issued", false, when],
      ["issueNumber", "Issue no."],
      ["requisition", "Requisition", false, (v) => v.requisitionNumber],
      ["outlet", "Outlet", false, (v) => v.name],
      ["item", "Item", false, (v) => v.itemName],
      ["quantityRequested", "Requested", true, (v) => num(v, 3)],
      ["quantityIssued", "Issued", true, (v, r) => `${num(v, 3)} ${r.item.unitOfMeasure}`],
      ["unitCost", "Unit cost", true, money],
      ["issueValue", "Value", true, money],
      ["batchAllocations", "From batches", false, (v) => v.map((a) => `${a.batchNumber} ×${num(a.quantity, 3)}`).join(", ") || "–"],
      ["issuedBy", "By"],
    ],
    batches: [
      ["item", "Item", false, (v) => v.itemName],
      ["batchNumber", "Batch"],
      ["source", "Source", false, label],
      ["receivedAt", "Received", false, date],
      ["expiryDate", "Expiry", false, (v) => {
        if (!v) return "–";
        const days = Math.floor((new Date(v) - Date.now()) / 864e5);
        return <span className={days < 0 ? "badge EXPIRED" : days <= 7 ? "badge EXPIRING" : ""}>{date(v)}</span>;
      }],
      ["quantityRemaining", "Remaining", true, (v, r) => `${num(v, 3)} ${r.item.unitOfMeasure}`],
      ["quantityReceived", "Received", true, (v) => num(v, 3)],
      ["unitCost", "Unit cost", true, money],
      ["value", "Value", true, (v, r) => money(Number(r.quantityRemaining) * Number(r.unitCost))],
    ],
    audit: [
      ["id", "#", true],
      ["occurredAt", "Time", false, when],
      ["actorName", "User"],
      ["actorRole", "Role"],
      ["method", "Action"],
      ["path", "Path"],
      ["statusCode", "Result", true, (v) => <span className={`badge ${v < 300 ? "OK" : v < 500 ? "REORDER" : "REJECTED"}`}>{v}</span>],
      ["requestBody", "Details", false, (v) => (v ? <code className="audit-body">{JSON.stringify(v)}</code> : "")],
    ],
  };

  return (
    <div className="page">
      <h2>Ledger &amp; Audit</h2>
      <Verification />
      <div className="tabs" role="tablist">
        {TABS.filter(([key]) => key !== "audit" || role === "admin").map(([key, text]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
            {text}
          </button>
        ))}
      </div>
      <div className="toolbar">
        {tab !== "audit" && (
          <select value={itemId} onChange={(e) => setItemId(e.target.value)} aria-label="Item">
            <option value="">All items</option>
            {items.map((i) => <option key={i.id} value={i.id}>{i.itemName}</option>)}
          </select>
        )}
        {tab === "batches" && (
          <select value={expiringWithinDays} onChange={(e) => setExpiringWithinDays(e.target.value)} aria-label="Expiry window">
            <option value="">All batches in stock</option>
            <option value="0">Expired</option>
            <option value="3">Expiring within 3 days</option>
            <option value="7">Expiring within 7 days</option>
            <option value="30">Expiring within 30 days</option>
          </select>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {data.tab === tab ? <Table columns={columns[tab]} rows={data.rows} /> : <p className="muted">Loading…</p>}
      {data.tab === tab && data.next && <button type="button" onClick={more}>Load older</button>}
    </div>
  );
}
