import axios from "axios";

// Same-origin by default: the server serves both this app and /api.
// During `npm start` the dev server proxies /api to the server on port 5100 (see "proxy" in package.json).
const API_URL = process.env.REACT_APP_API_URL || "/api";

const api = axios.create({
  baseURL: API_URL,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// An expired or revoked session sends the user back to the login page.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const isAuthCall = error.config?.url?.startsWith("/auth/");
    if (error.response?.status === 401 && !isAuthCall) {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      window.location.assign("/login");
    }
    return Promise.reject(error);
  }
);

export const errorMessage = (err, fallback = "Request failed") =>
  err.response?.data?.message || err.message || fallback;

export default api;
