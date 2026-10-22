import React from "react";
import { useSelector } from "react-redux";
import { Navigate } from "react-router-dom";

// Requires a login, and optionally one of `roles`. Staff ("user") land on Requisitions,
// everyone else on the dashboard, when a page isn't theirs.
export default function ProtectedRoute({ children, roles }) {
  const token = useSelector((state) => state.auth.token);
  const role = useSelector((state) => state.auth.user?.role);
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  if (roles && !roles.includes(role)) {
    return <Navigate to={role === "user" ? "/requisitions" : "/"} replace />;
  }
  return children;
}
