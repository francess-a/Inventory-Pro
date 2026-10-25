import React, { useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import { setItems } from "../store/inventorySlice";
import api from "../services/api";

export default function Dashboard() {
  const dispatch = useDispatch();
  const stockValue = useSelector((state) => state.inventory.totalValue);

  useEffect(() => {
    api.get("/items").then((res) => {
      dispatch(setItems(res.data));
    });
  }, [dispatch]);

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
