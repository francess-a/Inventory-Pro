import React, { useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import { setItems } from "../store/inventorySlice";
import api from "../services/api";

export default function Items() {
  const dispatch = useDispatch();
  const items = useSelector((state) => state.inventory.items);

  useEffect(() => {
    api.get("/items").then((res) => {
      dispatch(setItems(res.data));
    });
  }, [dispatch]);

  return (
    <div>
      <h1>Items</h1>
      <ul>
        {items.map((item) => (
          <li key={item._id}>
            {item.name} - {item.qty} units @ ${item.price}
          </li>
        ))}
      </ul>
    </div>
  );
}
