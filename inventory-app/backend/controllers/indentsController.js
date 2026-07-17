const Indent = require("../models/indentModel");
const Transaction = require("../models/transactionModel");

const getIndents = async (req, res) => {
  const indents = await Indent.find();
  res.json(indents);
};

const getPendingIndents = async (req, res) => {
  const pendingIndents = await Indent.find({ status: "Pending" });
  res.json(pendingIndents);
};

const createIndent = async (req, res) => {
  const { department, item, qty } = req.body;
  const newIndent = new Indent({
    department,
    item,
    qty,
    status: "Pending",
    requestedBy: req.user?.email || "unknown",
  });
  await newIndent.save();
  res.json(newIndent);
};

const updateIndent = async (req, res) => {
  const updatedIndent = await Indent.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  });
  if (!updatedIndent) {
    return res.status(404).json({ message: "Indent not found" });
  }
  res.json(updatedIndent);
};

const approveIndent = async (req, res) => {
  const indent = await Indent.findById(req.params.id);
  if (!indent) {
    return res.status(404).json({ message: "Indent not found" });
  }

  indent.status = "Approved";
  indent.approverComment = req.body.approverComment || "Approved";
  indent.reviewedAt = new Date();
  await indent.save();

  const transaction = new Transaction({
    itemName: indent.item,
    qty: indent.qty,
    type: "Issue",
    department: indent.department,
  });

  await transaction.save();
  res.json({ indent, transaction });
};

const rejectIndent = async (req, res) => {
  const indent = await Indent.findById(req.params.id);
  if (!indent) {
    return res.status(404).json({ message: "Indent not found" });
  }

  indent.status = "Rejected";
  indent.approverComment = req.body.approverComment || "Rejected";
  indent.reviewedAt = new Date();
  await indent.save();
  res.json(indent);
};

const getReports = async (req, res) => {
  const transactions = await Transaction.find().sort({ date: -1 }).limit(100);
  const summary = await Transaction.aggregate([
    {
      $group: {
        _id: "$itemName",
        qty: { $sum: "$qty" },
        count: { $sum: 1 },
      },
    },
    { $sort: { qty: -1 } },
  ]);

  res.json({ transactions, summary });
};

module.exports = {
  getIndents,
  getPendingIndents,
  createIndent,
  updateIndent,
  approveIndent,
  rejectIndent,
  getReports,
};
