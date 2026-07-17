import React, { useEffect, useState } from "react";
import api from "../services/api";

export default function Indents() {
  const [department, setDepartment] = useState("");
  const [item, setItem] = useState("");
  const [qty, setQty] = useState(1);
  const [indents, setIndents] = useState([]);
  const [pendingIndents, setPendingIndents] = useState([]);
  const [error, setError] = useState("");

  const loadIndents = async () => {
    try {
      const response = await api.get("/indents");
      setIndents(response.data);
    } catch (err) {
      setError("Unable to load indents");
    }
  };

  const loadPending = async () => {
    try {
      const response = await api.get("/indents/pending");
      setPendingIndents(response.data);
    } catch (err) {
      setPendingIndents([]);
    }
  };

  useEffect(() => {
    loadIndents();
    loadPending();
  }, []);

  const handleSubmit = async () => {
    try {
      await api.post("/indents", { department, item, qty });
      setDepartment("");
      setItem("");
      setQty(1);
      loadIndents();
      loadPending();
      alert("Indent submitted!");
    } catch (err) {
      setError(err.response?.data?.message || "Submit failed");
    }
  };

  const handleApprove = async (id) => {
    await api.post(`/indents/${id}/approve`, { approverComment: "Approved by reviewer" });
    loadIndents();
    loadPending();
  };

  const handleReject = async (id) => {
    await api.post(`/indents/${id}/reject`, { approverComment: "Rejected by reviewer" });
    loadIndents();
    loadPending();
  };

  return (
    <div>
      <h2>Raise Indent</h2>
      {error && <p className="error">{error}</p>}
      <input placeholder="Department" value={department} onChange={(e) => setDepartment(e.target.value)} />
      <input placeholder="Item" value={item} onChange={(e) => setItem(e.target.value)} />
      <input type="number" min="1" placeholder="Qty" value={qty} onChange={(e) => setQty(Number(e.target.value))} />
      <button type="button" onClick={handleSubmit}>Submit</button>

      <section>
        <h3>Indent History</h3>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Qty</th>
              <th>Status</th>
              <th>Department</th>
              <th>Requested By</th>
            </tr>
          </thead>
          <tbody>
            {indents.map((indent) => (
              <tr key={indent._id}>
                <td>{indent.item}</td>
                <td>{indent.qty}</td>
                <td>{indent.status}</td>
                <td>{indent.department}</td>
                <td>{indent.requestedBy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h3>Pending Approvals</h3>
        {pendingIndents.length === 0 ? (
          <p>No pending indents.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Qty</th>
                <th>Department</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {pendingIndents.map((indent) => (
                <tr key={indent._id}>
                  <td>{indent.item}</td>
                  <td>{indent.qty}</td>
                  <td>{indent.department}</td>
                  <td>
                    <button type="button" onClick={() => handleApprove(indent._id)}>
                      Approve
                    </button>
                    <button type="button" onClick={() => handleReject(indent._id)}>
                      Reject
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
