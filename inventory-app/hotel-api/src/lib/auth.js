// Accepts the same JWTs issued by the existing auth service (backend/routes/authRoutes.js).
const jwt = require("jsonwebtoken");
const config = require("../config");

const auth = (req, res, next) => {
  if (config.authDisabled) {
    req.user = { name: "system", role: "admin" };
    return next();
  }
  const authorization = req.headers.authorization;
  if (!authorization || !authorization.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Authorization token required" });
  }
  try {
    req.user = jwt.verify(authorization.split(" ")[1], config.jwtSecret);
    return next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};

const userName = (req) => req.user?.name || req.user?.email || "unknown";

module.exports = { auth, userName };
