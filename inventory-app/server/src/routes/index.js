const express = require("express");
const { requireRole, userName } = require("../lib/auth");
const { text } = require("../lib/http");
const inventory = require("../services/inventory");
const purchasing = require("../services/purchasing");
const requisitions = require("../services/requisitions");
const vendors = require("../services/vendors");
const market = require("../services/market");
const replenishment = require("../services/replenishment");
const reports = require("../services/reports");
const { analytics } = require("../services/analytics");

const router = express.Router();

// Store staff ("user") can raise requisitions, receive goods, issue stock, record waste and
// prices. Approvals, master data, purchase commitments and stock corrections need an approver.
const approver = requireRole("approver", "admin");

// Item master & stock
router.get("/items", async (req, res) => res.json(await inventory.listItems(req.query)));
router.post("/items", approver, async (req, res) => res.status(201).json(await inventory.createItem(req.body)));
router.get("/items/:id", async (req, res) => res.json(await inventory.getItem(req.params.id)));
router.patch("/items/:id", approver, async (req, res) => res.json(await inventory.updateItem(req.params.id, req.body)));

router.get("/departments", async (req, res) => res.json(await inventory.listDepartments()));
router.post("/departments", approver, async (req, res) => res.status(201).json(await inventory.createDepartment(req.body)));

router.get("/stock/outlets", async (req, res) => res.json(await inventory.outletStock(req.query.outletDepartmentId)));
router.post("/stock/adjustments", approver, async (req, res) => res.status(201).json(await inventory.adjustStock(req.body)));
router.post("/stock/waste", async (req, res) => res.status(201).json(await inventory.recordWaste(req.body)));
router.get("/transactions", async (req, res) => res.json(await inventory.listTransactions(req.query)));

// Vendors & scorecards
router.get("/vendors", async (req, res) => res.json(await vendors.listVendors()));
router.post("/vendors", approver, async (req, res) => res.status(201).json(await vendors.createVendor(req.body)));
router.patch("/vendors/:id", approver, async (req, res) => res.json(await vendors.updateVendor(req.params.id, req.body)));
router.get("/vendors/scorecards", async (req, res) => res.json(await vendors.listScorecards()));
router.get("/vendors/:id/scorecard", async (req, res) => res.json(await vendors.getScorecard(req.params.id)));

// Purchasing
router.get("/purchase-orders", async (req, res) => res.json(await purchasing.listPurchaseOrders(req.query)));
router.post("/purchase-orders", async (req, res) => res.status(201).json(await purchasing.createPurchaseOrder(req.body)));
router.post("/purchase-orders/direct", approver, async (req, res) =>
  res.status(201).json(await purchasing.createDirectPurchase(req.body))
);
router.get("/purchase-orders/:id", async (req, res) => res.json(await purchasing.getPurchaseOrder(req.params.id)));
router.post("/purchase-orders/:id/send", approver, async (req, res) => res.json(await purchasing.sendPurchaseOrder(req.params.id)));
router.post("/purchase-orders/:id/receive", async (req, res) =>
  res.json(await purchasing.receivePurchaseOrder(req.params.id, req.body))
);
router.post("/purchase-orders/:id/cancel", approver, async (req, res) => res.json(await purchasing.cancelPurchaseOrder(req.params.id)));

// Requisitions (department indents -> issues)
router.get("/requisitions", async (req, res) => res.json(await requisitions.listRequisitions(req.query)));
router.post("/requisitions", async (req, res) =>
  res.status(201).json(await requisitions.createRequisition(req.body, userName(req)))
);
router.get("/requisitions/:id", async (req, res) => res.json(await requisitions.getRequisition(req.params.id)));
router.post("/requisitions/:id/approve", approver, async (req, res) =>
  res.json(await requisitions.approveRequisition(req.params.id, userName(req), text(req.body?.remarks, "remarks", { optional: true })))
);
router.post("/requisitions/:id/reject", approver, async (req, res) =>
  res.json(await requisitions.rejectRequisition(req.params.id, userName(req), text(req.body?.remarks, "remarks", { optional: true })))
);
router.post("/requisitions/:id/issue", async (req, res) =>
  res.json(await requisitions.issueRequisition(req.params.id, req.body ?? {}, userName(req)))
);

// Replenishment
router.get("/replenishment", async (req, res) => {
  const rows = await replenishment.buildPlan();
  res.json(req.query.onlyReorder === "true" ? rows.filter((r) => r.needsReorder) : rows);
});
router.post("/replenishment/recalculate", approver, async (req, res) => res.json(await replenishment.recalculate()));
router.post("/replenishment/purchase-orders", approver, async (req, res) =>
  res.status(201).json(await replenishment.generatePurchaseOrders(req.body ?? {}))
);

// Market prices
router.get("/market/comparison", async (req, res) =>
  res.json(await market.priceComparison({ days: Number(req.query.days) || 30 }))
);
router.get("/market/items/:id/trend", async (req, res) =>
  res.json(await market.itemTrend(req.params.id, { days: Number(req.query.days) || 90 }))
);
router.post("/market/prices", async (req, res) => res.status(201).json(await market.recordPrice(req.body)));
router.post("/market/prices/import", async (req, res) =>
  res.status(201).json(await market.importMarketPrices(req.body?.prices, { defaultMarket: req.body?.market }))
);
router.post("/market/feed/sync", approver, async (req, res) => res.json(await market.syncMarketFeed()));

// Reports
router.get("/reports/dashboard", async (req, res) => res.json(await reports.dashboard()));
router.get("/reports/analytics", async (req, res) => res.json(await analytics(req.query)));
router.get("/reports/department-consumption", async (req, res) =>
  res.json(await requisitions.departmentConsumption(req.query))
);

module.exports = router;
