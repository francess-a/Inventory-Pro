const express = require("express");
const cors = require("cors");
const { auth } = require("./lib/auth");
const { errorHandler } = require("./lib/http");
const routes = require("./routes");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (req, res) => res.json({ status: "ok" }));
app.use("/api", auth, routes);
app.use((req, res) => res.status(404).json({ message: "Not found" }));
app.use(errorHandler);

module.exports = app;
