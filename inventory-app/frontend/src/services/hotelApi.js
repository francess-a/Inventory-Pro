import axios from "axios";

// Hotel inventory service (inventory-app/hotel-api). Uses the same login token as api.js.
const HOTEL_API_URL = process.env.REACT_APP_HOTEL_API_URL || "http://localhost:5100/api";

const hotelApi = axios.create({
  baseURL: HOTEL_API_URL,
});

hotelApi.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export const errorMessage = (err, fallback = "Request failed") =>
  err.response?.data?.message || err.message || fallback;

export default hotelApi;
