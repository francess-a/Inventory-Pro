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
const valuation = require("../services/valuation");
const controlling = require("../services/controlling");
const audit = require("../services/audit");
const { analytics } = require("../services/analytics");

const router = express.Router();

// Staff ("user") only work with requisitions: they raise them, follow their status and see the
// indent vs received report. Everything else (approving and issuing, purchasing, stock, master
// data and the management reports) is for approvers and admins.
const approver = requireRole("approver", "admin");
const admin = requireRole("admin");

const STAFF_ROUTES = [
  ["GET", /^\/items$/], // item picker on the requisition form
  ["GET", /^\/departments$/],
  ["GET", /^\/requisitions(\/[^/]+)?$/],
  ["POST", /^\/requisitions$/],
  ["GET", /^\/reports\/indent-vs-received$/],
];
router.use((req, res, next) => {
  if (req.user?.role !== "user") return next();
  if (STAFF_ROUTES.some(([method, path]) => method === req.method && path.test(req.path))) return next();
  return res.status(403).json({ message: "Staff accounts can only raise and track requisitions" });
});

// Item categories (group > category > sub-category)
router.get("/categories", async (req, res) => res.json(await inventory.listCategories()));
router.post("/categories", approver, async (req, res) => res.status(201).json(await inventory.createCategory(req.body)));
router.patch("/categories/:code", approver, async (req, res) => res.json(await inventory.updateCategory(req.params.code, req.body)));

// Item master & stock
router.get("/items", async (req, res) => res.json(await inventory.listItems(req.query)));
router.post("/items", approver, async (req, res) => res.status(201).json(await inventory.createItem(req.body)));
router.get("/items/:id", async (req, res) => res.json(await inventory.getItem(req.params.id)));
router.patch("/items/:id", approver, async (req, res) => res.json(await inventory.updateItem(req.params.id, req.body)));

// Outlets (outlet_master) and their daily revenue
router.get("/departments", async (req, res) => res.json(await inventory.listDepartments(req.query)));
router.post("/departments", approver, async (req, res) => res.status(201).json(await inventory.createDepartment(req.body)));
router.patch("/departments/:id", approver, async (req, res) => res.json(await inventory.updateDepartment(req.params.id, req.body)));
router.get("/revenue", async (req, res) => res.json(await controlling.listRevenue(req.query)));
router.put("/departments/:id/revenue", approver, async (req, res) =>
  res.json(await controlling.recordRevenue(req.params.id, req.body, userName(req)))
);

router.get("/stock/outlets", async (req, res) => res.json(await inventory.outletStock(req.query.outletDepartmentId)));
router.post("/stock/adjustments", approver, async (req, res) =>
  res.status(201).json(await inventory.adjustStock(req.body, userName(req)))
);
router.post("/stock/waste", async (req, res) => res.status(201).json(await inventory.recordWaste(req.body, userName(req))));
router.get("/transactions", async (req, res) => res.json(await inventory.listTransactions(req.query)));

// Ledgers (read-only) and audit
router.get("/ledger/transactions", async (req, res) => res.json(await audit.listLedger(req.query)));
router.get("/ledger/verify", approver, async (req, res) => res.json(await audit.verifyLedger(req.query)));
router.get("/ledger/inward", async (req, res) => res.json(await audit.listInward(req.query)));
router.get("/ledger/issues", async (req, res) => res.json(await audit.listIssues(req.query)));
router.get("/ledger/batches", async (req, res) => res.json(await audit.listBatches(req.query)));
router.get("/audit/log", admin, async (req, res) => res.json(await audit.listAuditLog(req.query)));

// Vendors & scorecards
router.get("/vendors", async (req, res) => res.json(await vendors.listVendors()));
router.post("/vendors", approver, async (req, res) => res.status(201).json(await vendors.createVendor(req.body)));
router.patch("/vendors/:id", approver, async (req, res) => res.json(await vendors.updateVendor(req.params.id, req.body)));
router.get("/vendors/scorecards", async (req, res) => res.json(await vendors.listScorecards()));
router.post("/vendors/ratings/refresh", approver, async (req, res) => res.json(await vendors.refreshRatings()));
router.get("/vendors/:id/scorecard", async (req, res) => res.json(await vendors.getScorecard(req.params.id)));

// Purchasing
router.get("/purchase-orders", async (req, res) => res.json(await purchasing.listPurchaseOrders(req.query)));
router.post("/purchase-orders", async (req, res) => res.status(201).json(await purchasing.createPurchaseOrder(req.body)));
router.post("/purchase-orders/direct", approver, async (req, res) =>
  res.status(201).json(await purchasing.createDirectPurchase(req.body, userName(req)))
);
router.get("/purchase-orders/:id", async (req, res) => res.json(await purchasing.getPurchaseOrder(req.params.id)));
router.post("/purchase-orders/:id/send", approver, async (req, res) => res.json(await purchasing.sendPurchaseOrder(req.params.id)));
router.post("/purchase-orders/:id/receive", async (req, res) =>
  res.json(await purchasing.receivePurchaseOrder(req.params.id, req.body, userName(req)))
);
router.post("/purchase-orders/:id/cancel", approver, async (req, res) => res.json(await purchasing.cancelPurchaseOrder(req.params.id)));
router.post("/purchase-orders/:id/close", approver, async (req, res) =>
  res.json(await purchasing.closePurchaseOrder(req.params.id, req.body?.reason))
);

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
// Send an Idempotency-Key header (or body.idempotencyKey) so a retried issue returns the
// original result instead of failing or deducting twice.
router.post("/requisitions/:id/issue", approver, async (req, res) => {
  const key = req.get("Idempotency-Key") ?? req.body?.idempotencyKey;
  const idempotencyKey = key === undefined ? undefined : text(key, "idempotencyKey").slice(0, 200);
  res.json(await requisitions.issueRequisition(req.params.id, req.body ?? {}, userName(req), idempotencyKey));
});

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
router.get("/reports/indent-vs-received", async (req, res) => res.json(await requisitions.indentVsReceived(req.query)));
router.get("/reports/department-consumption", async (req, res) =>
  res.json(await requisitions.departmentConsumption(req.query))
);
router.get("/reports/outlet-cogs", async (req, res) => res.json(await controlling.outletCogs(req.query)));
router.get("/reports/inventory-health", async (req, res) => res.json(await controlling.inventoryHealth(req.query)));
router.get("/reports/abc-xyz", async (req, res) => res.json(await controlling.abcXyzMatrix()));
router.get("/reports/forecast", async (req, res) => res.json(await controlling.forecastReport(req.query)));

// Closing stock valuation (closing_stock_daily_valuation)
router.get("/valuation/daily", async (req, res) => res.json(await valuation.dailyTotals(req.query)));
router.get("/valuation/items", async (req, res) => res.json(await valuation.itemsOnDay(req.query)));
router.post("/valuation/snapshots", approver, async (req, res) => res.status(201).json(await valuation.createSnapshots(req.body ?? {})));

module.exports = router;
