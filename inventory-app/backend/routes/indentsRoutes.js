const express = require("express");
const router = express.Router();
const { auth, authorizeRoles } = require("../middleware/authMiddleware");
const {
  getIndents,
  getPendingIndents,
  createIndent,
  updateIndent,
  approveIndent,
  rejectIndent,
  getReports,
} = require("../controllers/indentsController");

router.get("/", auth, getIndents);
router.get("/pending", auth, authorizeRoles("approver", "admin"), getPendingIndents);
router.get("/reports", auth, getReports);
router.post("/", auth, createIndent);
router.put("/:id", auth, updateIndent);
router.post("/:id/approve", auth, authorizeRoles("approver", "admin"), approveIndent);
router.post("/:id/reject", auth, authorizeRoles("approver", "admin"), rejectIndent);

module.exports = router;
