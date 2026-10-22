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
import Reports from "./pages/Reports";
import IndentReport from "./pages/IndentReport";
import Valuation from "./pages/Valuation";
import Ledger from "./pages/Ledger";
import NavBar from "./components/NavBar";
import ProtectedRoute from "./components/ProtectedRoute";

const MANAGERS = ["approver", "admin"];
const EVERYONE = ["user", "approver", "admin"];

function App() {
  return (
    <BrowserRouter>
      <NavBar />
      <Routes>
        <Route path="/login" element={<Login />} />
        {/* Staff ("user") only see requisitions and the indent report; the rest is for approvers and admins. */}
        {[
          ["/", <Dashboard />, MANAGERS],
          ["/stock", <Stock />, MANAGERS],
          ["/purchases", <Purchases />, MANAGERS],
          ["/requisitions", <Requisitions />, EVERYONE],
          ["/indent-report", <IndentReport />, EVERYONE],
          ["/vendors", <Vendors />, MANAGERS],
          ["/market", <MarketPrices />, MANAGERS],
          ["/reports", <Reports />, MANAGERS],
          ["/valuation", <Valuation />, MANAGERS],
          ["/ledger", <Ledger />, MANAGERS],
          ["/users", <Users />, ["admin"]],
        ].map(([path, page, roles]) => (
          <Route key={path} path={path} element={<ProtectedRoute roles={roles}>{page}</ProtectedRoute>} />
        ))}
        {/* Superseded pages of the original app: items -> stock, indents -> requisitions. */}
        <Route path="/items" element={<Navigate to="/stock" replace />} />
        <Route path="/indents" element={<Navigate to="/requisitions" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
