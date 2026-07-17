import React from "react";
import { useSelector } from "react-redux";

export default function Dashboard() {
  const stockValue = useSelector((state) => state.inventory.totalValue);

  return (
    <div className="dashboard">
      <h1>Inventory Dashboard</h1>
      <div className="card">
        <h3>Total Stock Value</h3>
        <p>${stockValue}</p>
        <span className="tooltip">Sum of all items in inventory</span>
      </div>
    </div>
  );
}
