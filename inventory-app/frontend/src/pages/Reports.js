import React, { useEffect, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import api from "../services/api";

export default function Reports() {
  const [transactions, setTransactions] = useState([]);
  const [summary, setSummary] = useState([]);

  useEffect(() => {
    api.get("/indents/reports")
      .then((res) => {
        setTransactions(res.data.transactions || []);
        setSummary(res.data.summary || []);
      })
      .catch(() => {
        setTransactions([]);
        setSummary([]);
      });
  }, []);

  return (
    <div>
      <h2>Usage Reports</h2>
      <section>
        <h3>Recent Transactions</h3>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Qty</th>
              <th>Type</th>
              <th>Department</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((tx) => (
              <tr key={tx._id}>
                <td>{tx.itemName}</td>
                <td>{tx.qty}</td>
                <td>{tx.type}</td>
                <td>{tx.department}</td>
                <td>{new Date(tx.date).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h3>Summary by Item</h3>
        <div style={{ width: "100%", height: 320 }}>
          <ResponsiveContainer>
            <BarChart data={summary} margin={{ top: 20, right: 24, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="_id" />
              <YAxis />
              <Tooltip />
              <Bar dataKey="qty" fill="#8884d8" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  );
}
