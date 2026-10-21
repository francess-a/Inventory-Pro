import { useSelector } from "react-redux";

// Mirrors the hotel API: approvals, master data, purchase commitments and stock
// corrections need an "approver" or "admin"; other store staff ("user") can raise
// requisitions, receive goods, issue stock and record prices.
export const useCanApprove = () => {
  const role = useSelector((state) => state.auth.user?.role);
  return role === "approver" || role === "admin";
};
