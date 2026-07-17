const mongoose = require("mongoose");

const indentSchema = new mongoose.Schema({
  department: { type: String, required: true },
  item: { type: String, required: true },
  qty: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ["Pending", "Approved", "Rejected"], default: "Pending" },
  requestedBy: { type: String },
  approverComment: { type: String },
  requestedAt: { type: Date, default: Date.now },
  reviewedAt: { type: Date },
});

module.exports = mongoose.model("Indent", indentSchema);
