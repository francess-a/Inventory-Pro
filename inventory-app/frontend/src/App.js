import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";
import Stock from "./pages/Stock";
import Purchases from "./pages/Purchases";
import Requisitions from "./pages/Requisitions";
import Vendors from "./pages/Vendors";
import MarketPrices from "./pages/MarketPrices";
import Users from "./pages/Users";
import NavBar from "./components/NavBar";
import ProtectedRoute from "./components/ProtectedRoute";

function App() {
  return (
    <BrowserRouter>
      <NavBar />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/stock"
          element={
            <ProtectedRoute>
              <Stock />
            </ProtectedRoute>
          }
        />
        <Route
          path="/purchases"
          element={
            <ProtectedRoute>
              <Purchases />
            </ProtectedRoute>
          }
        />
        <Route
          path="/requisitions"
          element={
            <ProtectedRoute>
              <Requisitions />
            </ProtectedRoute>
          }
        />
        <Route
          path="/vendors"
          element={
            <ProtectedRoute>
              <Vendors />
            </ProtectedRoute>
          }
        />
        <Route
          path="/market"
          element={
            <ProtectedRoute>
              <MarketPrices />
            </ProtectedRoute>
          }
        />
        <Route
          path="/users"
          element={
            <ProtectedRoute>
              <Users />
            </ProtectedRoute>
          }
        />
        {/* Superseded pages of the original app: items -> stock, indents & usage reports -> requisitions. */}
        <Route path="/items" element={<Navigate to="/stock" replace />} />
        <Route path="/indents" element={<Navigate to="/requisitions" replace />} />
        <Route path="/reports" element={<Navigate to="/requisitions" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
