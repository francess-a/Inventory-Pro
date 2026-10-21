import React, { useCallback, useEffect, useState } from "react";
import { useSelector } from "react-redux";
import api, { errorMessage } from "../services/api";
import { date } from "../utils/format";

const ROLES = [
  ["user", "Store staff"],
  ["approver", "Approver"],
  ["admin", "Administrator"],
];
const EMPTY = { name: "", email: "", password: "", role: "user" };

export default function Users() {
  const me = useSelector((state) => state.auth.user);
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api
      .get("/users")
      .then((res) => setUsers(res.data))
      .catch((err) => setError(errorMessage(err, "Unable to load users")));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const update = async (user, patch) => {
    try {
      await api.patch(`/users/${user.id}`, patch);
      setMessage(`${user.name} updated.`);
      setError("");
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const create = async (e) => {
    e.preventDefault();
    try {
      await api.post("/users", form);
      setMessage(`${form.name} added.`);
      setForm(EMPTY);
      setError("");
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const field = (name) => ({ value: form[name], onChange: (e) => setForm({ ...form, [name]: e.target.value }) });

  return (
    <div className="page">
      <h2>Users &amp; Roles</h2>
      <p className="muted">
        Store staff raise requisitions, receive goods and issue stock. Approvers also approve requisitions, send purchase
        orders, adjust stock and maintain items and vendors. Administrators also manage users.
      </p>
      {error && <p className="error">{error}</p>}
      {message && <p className="notice">{message}</p>}

      <form className="card form-grid" onSubmit={create}>
        <label>Name<input required {...field("name")} /></label>
        <label>Email<input required type="email" {...field("email")} /></label>
        <label>Temporary password<input required minLength={8} type="password" {...field("password")} /></label>
        <label>
          Role
          <select {...field("role")}>
            {ROLES.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select>
        </label>
        <label>&nbsp;<button type="submit" className="primary">Add user</button></label>
      </form>

      <div className="table-wrap">
      <table className="data">
        <thead>
          <tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Since</th><th /></tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td>{u.email}</td>
              <td>
                <select value={u.role} disabled={u.id === me?.id} onChange={(e) => update(u, { role: e.target.value })}>
                  {ROLES.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
                </select>
              </td>
              <td>{u.isActive ? "Active" : "Disabled"}</td>
              <td>{date(u.createdAt)}</td>
              <td>
                {u.id !== me?.id && (
                  <button type="button" className="link" onClick={() => update(u, { isActive: !u.isActive })}>
                    {u.isActive ? "Disable" : "Enable"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
