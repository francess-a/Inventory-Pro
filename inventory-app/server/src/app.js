const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const config = require("./config");
const { auth } = require("./lib/auth");
const { errorHandler } = require("./lib/http");
const routes = require("./routes");
const authRoutes = require("./routes/auth");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (req, res) => res.json({ status: "ok" }));
app.use("/api", authRoutes.publicRouter);
app.use("/api", auth, authRoutes.router, routes);
app.use("/api", (req, res) => res.status(404).json({ message: "Not found" }));

// The web app: static files from the React build, with client-side routes falling back to index.html.
const indexHtml = config.frontendDir && path.join(config.frontendDir, "index.html");
if (indexHtml && fs.existsSync(indexHtml)) {
  app.use(express.static(config.frontendDir, { index: false }));
  app.get(/.*/, (req, res) => res.sendFile(indexHtml));
}

app.use((req, res) => res.status(404).json({ message: "Not found" }));
app.use(errorHandler);

module.exports = app;
