import { configureStore } from "@reduxjs/toolkit";
import inventoryReducer from "./inventorySlice";
import authReducer from "./authSlice";

export const store = configureStore({
  reducer: {
    inventory: inventoryReducer,
    auth: authReducer,
  },
});
