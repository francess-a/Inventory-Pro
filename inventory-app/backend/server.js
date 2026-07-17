if (typeof global.crypto === "undefined") {
  if (typeof globalThis.crypto !== "undefined") {
    global.crypto = globalThis.crypto;
  } else {
    const { webcrypto } = require("crypto");
    global.crypto = webcrypto;
  }
}

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const itemRoutes = require("./routes/itemsRoutes");
const indentRoutes = require("./routes/indentsRoutes");
const authRoutes = require("./routes/authRoutes");

const app = express();
app.use(cors());
app.use(express.json());

const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/inventory";
const PORT = process.env.PORT || 5000;

mongoose
  .connect(mongoUri)
  .then(() => {
    console.log(`Connected to MongoDB at ${mongoUri}`);
    app.use("/api/auth", authRoutes);
    app.use("/api/items", itemRoutes);
    app.use("/api/indents", indentRoutes);
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((error) => {
    console.error("MongoDB connection error:", error.message);
    process.exit(1);
  });
