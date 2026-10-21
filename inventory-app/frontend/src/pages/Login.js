import React, { useState } from "react";
import { useDispatch } from "react-redux";
import { useNavigate } from "react-router-dom";
import api, { errorMessage } from "../services/api";
import { loginSuccess, setAuthError } from "../store/authSlice";

export default function Login() {
  const [mode, setMode] = useState("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const registering = mode === "register";

  const handleSubmit = async (event) => {
    event.preventDefault();
    try {
      const response = registering
        ? await api.post("/auth/register", { name, email, password })
        : await api.post("/auth/login", { email, password });
      const { token, user } = response.data;
      localStorage.setItem("token", token);
      localStorage.setItem("user", JSON.stringify(user));
      dispatch(loginSuccess({ token, user }));
      navigate("/");
    } catch (err) {
      const message = errorMessage(err, registering ? "Sign-up failed" : "Login failed");
      setError(message);
      dispatch(setAuthError(message));
    }
  };

  return (
    <div className="page login-page">
      <h2>{registering ? "Create account" : "Login"}</h2>
      <form className="card form-grid" style={{ maxWidth: 420, gridTemplateColumns: "1fr" }} onSubmit={handleSubmit}>
        {registering && (
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
        )}
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" minLength={registering ? 8 : undefined} value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="primary">{registering ? "Create account" : "Login"}</button>
        <button type="button" className="link" onClick={() => { setMode(registering ? "login" : "register"); setError(""); }}>
          {registering ? "Already have an account? Log in" : "New here? Create an account"}
        </button>
        {registering && (
          <p className="muted">The first account becomes the administrator. Later accounts start as store staff; an administrator can change roles.</p>
        )}
      </form>
    </div>
  );
}
