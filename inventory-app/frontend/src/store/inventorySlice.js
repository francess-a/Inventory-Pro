import { createSlice } from "@reduxjs/toolkit";

const inventorySlice = createSlice({
  name: "inventory",
  initialState: {
    items: [],
    totalValue: 0,
  },
  reducers: {
    setItems(state, action) {
      state.items = action.payload;
      state.totalValue = action.payload.reduce(
        (sum, item) => sum + item.price * item.qty,
        0
      );
    },
  },
});

export const { setItems } = inventorySlice.actions;
export default inventorySlice.reducer;
