const mongoose = require("mongoose");

const itemSchema = new mongoose.Schema({
  name: String,
  category: String,
  qty: Number,
  price: Number,
  reorderLevel: Number,
});

module.exports = mongoose.model("Item", itemSchema);
