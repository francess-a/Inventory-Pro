import React from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useDispatch, useSelector } from "react-redux";
import { logout } from "../store/authSlice";

export default function NavBar() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const user = useSelector((state) => state.auth.user);

  const handleLogout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    dispatch(logout());
    navigate("/login");
  };

  return (
    <nav className="nav-bar">
      <div className="nav-brand">Hotel Central Store</div>
      <div className="nav-links">
        <NavLink to="/">Dashboard</NavLink>
        <NavLink to="/stock">Stock</NavLink>
        <NavLink to="/purchases">Purchases</NavLink>
        <NavLink to="/requisitions">Requisitions</NavLink>
        <NavLink to="/vendors">Vendors</NavLink>
        <NavLink to="/market">Market Prices</NavLink>
      </div>
      <div className="nav-actions">
        {user ? (
          <>
            <span>{user.name} ({user.role})</span>
            <button type="button" onClick={handleLogout}>Logout</button>
          </>
        ) : (
          <NavLink to="/login">Login</NavLink>
        )}
      </div>
    </nav>
  );
}
