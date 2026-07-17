const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema({
  itemName: String,
  qty: Number,
  type: String, // "Issue" or "Purchase"
  department: String,
  date: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Transaction", transactionSchema);
