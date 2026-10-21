// End-to-end API test against a real PostgreSQL database.
// Requires TEST_DATABASE_URL; skipped when unset. The test creates its own uniquely
// named Postgres schema in that database and drops only that schema afterwards.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const path = require("node:path");

const TEST_DB = process.env.TEST_DATABASE_URL;

test("hotel inventory API", { skip: !TEST_DB && "TEST_DATABASE_URL not set" }, async (t) => {
  const schema = `api_test_${process.pid}_${Date.now()}`;
  const url = new URL(TEST_DB);
  url.searchParams.set("schema", schema);
  process.env.DATABASE_URL = url.toString();
  process.env.AUTH_DISABLED = "true";
  execSync("npx prisma db push --skip-generate", {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: "ignore",
  });

  const app = require("../src/app");
  const prisma = require("../src/db");
  const config = require("../src/config");
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  t.after(async () => {
    server.close();
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await prisma.$disconnect();
  });

  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const ok = async (method, url, body, expected = [200, 201]) => {
    const res = await call(method, url, body);
    assert.ok(expected.includes(res.status), `${method} ${url} -> ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const central = async (itemId) => (await ok("GET", `/items/${itemId}`)).centralStock;

  // ── Master data ──────────────────────────────────────────────
  const farm = await ok("POST", "/vendors", { vendorName: "Farm", contactName: "A", email: "a@x", phone: "1", leadTimeDays: 2 });
  const metro = await ok("POST", "/vendors", { vendorName: "Metro", contactName: "B", email: "b@x", phone: "2", leadTimeDays: 3 });
  const onion = await ok("POST", "/items", {
    sku: "ONI", barcode: "111", itemName: "Onion", category: "VEGETABLE", unitOfMeasure: "kg",
    preferredVendorId: farm.id, orderMultiple: 5,
  });
  const rice = await ok("POST", "/items", { sku: "RIC", barcode: "222", itemName: "Rice", category: "GROCERY", unitOfMeasure: "kg" });
  const kitchen = await ok("POST", "/departments", { mainOutlet: "FB", subDepartment: "TANDOOR" });

  await t.test("validation errors return 400 / 409", async () => {
    assert.equal((await call("POST", "/items", { sku: "X" })).status, 400);
    assert.equal((await call("POST", "/items", { sku: "ONI", barcode: "999", itemName: "Dup", category: "VEGETABLE", unitOfMeasure: "kg" })).status, 409);
    assert.equal((await call("POST", "/items", { sku: "Y", barcode: "9", itemName: "Y", category: "NOPE", unitOfMeasure: "kg" })).status, 400);
    assert.equal((await call("GET", "/items/not-a-uuid")).status, 400);
  });

  // ── Purchasing ───────────────────────────────────────────────
  let po;
  await t.test("purchase order: create, send, partial receipt with rejection", async () => {
    po = await ok("POST", "/purchase-orders", {
      vendorId: farm.id,
      items: [
        { itemId: onion.id, quantityOrdered: 100, unitPrice: 40 },
        { itemId: rice.id, quantityOrdered: 50, unitPrice: 90 },
      ],
    });
    assert.equal(po.status, "DRAFT");
    assert.equal(po.orderedValue, "8500");
    assert.equal((await call("POST", `/purchase-orders/${po.id}/receive`, { lines: [] })).status, 409);

    po = await ok("POST", `/purchase-orders/${po.id}/send`);
    assert.equal(po.status, "SENT");
    assert.ok(po.expectedDeliveryAt);

    const onionLine = po.items.find((l) => l.itemId === onion.id);
    const riceLine = po.items.find((l) => l.itemId === rice.id);
    const missingReason = await call("POST", `/purchase-orders/${po.id}/receive`, {
      lines: [{ poItemId: onionLine.id, quantityReceived: 50, quantityRejected: 10 }],
    });
    assert.equal(missingReason.status, 400);

    po = await ok("POST", `/purchase-orders/${po.id}/receive`, {
      lines: [
        { poItemId: onionLine.id, quantityReceived: 50, quantityRejected: 10, rejectionReason: "Rotten" },
        { poItemId: riceLine.id, quantityReceived: 50 },
      ],
    });
    assert.equal(po.status, "PARTIALLY_RECEIVED");
    assert.ok(po.receivedAt);
    const afterFirst = await central(onion.id);
    assert.equal(afterFirst.quantityOnHand, 50);
    assert.equal(afterFirst.totalValue, "2000");

    const over = await call("POST", `/purchase-orders/${po.id}/receive`, {
      lines: [{ poItemId: onionLine.id, quantityReceived: 41 }],
    });
    assert.equal(over.status, 400, "cannot receive more than outstanding (100 - 50 - 10 = 40)");

    // Remaining 40 arrive at a higher invoice price -> weighted average cost.
    po = await ok("POST", `/purchase-orders/${po.id}/receive`, {
      lines: [{ poItemId: onionLine.id, quantityReceived: 40, unitPrice: 49 }],
      invoiceNumber: "INV-1",
    });
    assert.equal(po.status, "RECEIVED");
    const item = await ok("GET", `/items/${onion.id}`);
    assert.equal(item.costPrice, "44"); // (50*40 + 40*49) / 90 = 44
    assert.equal(item.centralStock.quantityOnHand, 90);
    assert.equal(item.centralStock.totalValue, "3960");
  });

  await t.test("cancelled and received orders cannot be cancelled again", async () => {
    assert.equal((await call("POST", `/purchase-orders/${po.id}/cancel`)).status, 409);
    const draft = await ok("POST", "/purchase-orders", { vendorId: metro.id, items: [{ itemId: rice.id, quantity: 5, unitPrice: 85 }] });
    assert.equal((await ok("POST", `/purchase-orders/${draft.id}/cancel`)).status, "CANCELLED");
  });

  await t.test("direct purchase entry receives immediately", async () => {
    const direct = await ok("POST", "/purchase-orders/direct", {
      vendorId: metro.id,
      invoiceNumber: "CASH-7",
      items: [{ itemId: rice.id, quantityOrdered: 20, unitPrice: 80, quantityRejected: 2, rejectionReason: "Torn bag" }],
    });
    assert.equal(direct.status, "RECEIVED");
    assert.equal(direct.items[0].quantityReceived, 18);
    assert.equal((await central(rice.id)).quantityOnHand, 68);
  });

  // ── Requisitions & issues ────────────────────────────────────
  await t.test("requisition: approve then issue at weighted average cost", async () => {
    let req = await ok("POST", "/requisitions", {
      outletDepartmentId: kitchen.id,
      requestedBy: "Chef",
      items: [
        { itemId: onion.id, quantityRequested: 30 },
        { itemId: rice.id, quantityRequested: 10 },
      ],
    });
    assert.equal(req.status, "PENDING");
    assert.match(req.requisitionNumber, /^REQ-/);
    assert.equal((await call("POST", `/requisitions/${req.id}/issue`, {})).status, 409, "must be approved first");

    req = await ok("POST", `/requisitions/${req.id}/approve`);
    assert.equal(req.status, "APPROVED");
    assert.equal(req.approvedBy, "system");

    const onionLine = req.items.find((l) => l.itemId === onion.id);
    req = await ok("POST", `/requisitions/${req.id}/issue`, {
      lines: [{ requisitionItemId: onionLine.id, quantityIssued: 25 }],
    });
    assert.equal(req.status, "ISSUED");
    const issuedOnion = req.items.find((l) => l.itemId === onion.id);
    assert.equal(issuedOnion.quantityIssued, 25);
    assert.equal(issuedOnion.unitCost, "44");
    assert.equal(issuedOnion.issuedValue, "1100");
    assert.equal((await central(onion.id)).quantityOnHand, 65);

    const outlet = await ok("GET", `/stock/outlets?outletDepartmentId=${kitchen.id}`);
    assert.equal(outlet.find((s) => s.itemId === onion.id).quantityOnHand, 25);

    const tx = await ok("GET", `/transactions?itemId=${onion.id}&type=OUTLET_ISSUE`);
    assert.equal(tx[0].closingStockCentral, 65);
    assert.equal(tx[0].closingStockCentralValue, "2860");
    assert.equal(tx[0].destinationLocation, kitchen.id);
  });

  await t.test("issuing more than central stock fails and rolls back every line", async () => {
    let req = await ok("POST", "/requisitions", {
      outletDepartmentId: kitchen.id,
      items: [
        { itemId: rice.id, quantityRequested: 5 },
        { itemId: onion.id, quantityRequested: 1000 },
      ],
    });
    req = await ok("POST", `/requisitions/${req.id}/approve`);
    const before = (await central(rice.id)).quantityOnHand;
    assert.equal((await call("POST", `/requisitions/${req.id}/issue`, {})).status, 409);
    assert.equal((await central(rice.id)).quantityOnHand, before);
    assert.equal((await ok("GET", `/requisitions/${req.id}`)).status, "APPROVED");
  });

  await t.test("waste and stock adjustments", async () => {
    await ok("POST", "/stock/waste", { itemId: onion.id, quantity: 5, reason: "Spoiled" });
    assert.equal((await central(onion.id)).quantityOnHand, 60);
    await ok("POST", "/stock/waste", { itemId: onion.id, quantity: 5, location: kitchen.id, reason: "Burnt" });
    const outlet = await ok("GET", `/stock/outlets?outletDepartmentId=${kitchen.id}`);
    assert.equal(outlet.find((s) => s.itemId === onion.id).quantityOnHand, 20);
    assert.equal((await call("POST", "/stock/waste", { itemId: onion.id, quantity: 500, location: kitchen.id, reason: "x" })).status, 409);
    await ok("POST", "/stock/adjustments", { itemId: onion.id, quantityChange: -2, reason: "Count variance" });
    assert.equal((await central(onion.id)).quantityOnHand, 58);
    assert.equal((await call("POST", "/stock/adjustments", { itemId: onion.id, quantityChange: -100, reason: "x" })).status, 409);
  });

  await t.test("department consumption report", async () => {
    const report = await ok("GET", "/reports/department-consumption");
    assert.equal(report.departments.length, 1);
    // 25 kg onion @ 44 + 10 kg rice @ 87.35 ((50*90 + 18*80) / 68)
    assert.equal(report.departments[0].totalValue, "1973.5");
  });

  // ── Vendor scorecards ────────────────────────────────────────
  await t.test("vendor scorecard reflects fill rate and rejections", async () => {
    const card = await ok("GET", `/vendors/${farm.id}/scorecard`);
    assert.equal(card.purchaseOrdersDelivered, 1);
    assert.equal(card.fillRate, 140 / 150);
    assert.equal(card.qualityAcceptanceRate, 140 / 150);
    assert.equal(card.onTimeDeliveryRate, 1);
    assert.ok(card.overallScore > 0);
    const all = await ok("GET", "/vendors/scorecards");
    assert.equal(all.length, 2);
  });

  // ── Market prices ────────────────────────────────────────────
  await t.test("market prices: record, import, trend and comparison", async () => {
    await ok("POST", "/market/prices", { itemId: onion.id, unitPrice: 38, market: "Wholesale" });
    await ok("POST", "/market/prices", { itemId: onion.id, vendorId: metro.id, unitPrice: 41 });
    assert.equal((await call("POST", "/market/prices", { itemId: onion.id, source: "VENDOR_QUOTE", unitPrice: 1 })).status, 400);
    const imported = await ok("POST", "/market/prices/import", {
      market: "Mandi",
      prices: [{ sku: "RIC", unitPrice: 70 }, { sku: "NOPE", unitPrice: 1 }],
    });
    assert.deepEqual(imported, { imported: 1, unknownSkus: ["NOPE"] });

    const trend = await ok("GET", `/market/items/${onion.id}/trend`);
    assert.equal(trend.latestMarketPrice, 38);
    assert.equal(trend.bestVendor.vendorName, "Metro");
    assert.ok(trend.series.length >= 3); // market, farm receipts, metro quote
    assert.ok(Math.abs(trend.costVsMarketPct - ((44 - 38) / 38) * 100) < 1e-9);

    const comparison = await ok("GET", "/market/comparison");
    const onionRow = comparison.find((r) => r.sku === "ONI");
    assert.equal(onionRow.marketPrice, 38);
    assert.equal(onionRow.bestVendorPrice, 41);
    assert.ok(Math.abs(onionRow.potentialSavingPct - (6 / 44) * 100) < 1e-9);
  });

  // ── Replenishment ────────────────────────────────────────────
  await t.test("replenishment plan, recalculation and PO generation", async () => {
    // Back-date heavy onion usage so the plan computes levels above current stock.
    const now = Date.now();
    await prisma.inventoryTransaction.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        itemId: onion.id,
        type: "OUTLET_ISSUE",
        sourceLocation: "CENTRAL",
        destinationLocation: kitchen.id,
        quantity: 10 + (i % 3),
        unitCost: 44,
        transactionValue: 44 * (10 + (i % 3)),
        closingStockCentral: 58,
        closingStockCentralValue: 2552,
        timestamp: new Date(now - (i + 1) * 24 * 60 * 60 * 1000),
      })),
    });

    const plan = await ok("GET", "/replenishment");
    const row = plan.find((r) => r.itemId === onion.id);
    assert.equal(row.planningSource, "COMPUTED");
    assert.equal(row.vendorId, farm.id);
    assert.equal(row.leadTimeSource, "ACTUAL");
    assert.ok(row.avgDailyUsage > 3);
    assert.ok(row.reorderPoint >= row.minStock);
    assert.ok(row.maxStock >= row.reorderPoint);
    assert.equal(row.abcCategory, "A");
    if (row.needsReorder) assert.equal(row.suggestedOrderQty % 5, 0, "rounded to orderMultiple");

    const result = await ok("POST", "/replenishment/recalculate");
    assert.equal(result.itemsUpdated, 2);
    const updated = await ok("GET", `/items/${onion.id}`);
    assert.equal(updated.reorderPoint, row.reorderPoint);
    assert.equal(updated.abcCategory, "A");

    // Manually maintained levels: with autoPlanning off, the stored levels drive the order.
    await ok("PATCH", `/items/${rice.id}`, { autoPlanning: false, reorderPoint: 500, maxStockLevel: 800, preferredVendorId: metro.id });
    const riceRow = (await ok("GET", "/replenishment")).find((r) => r.itemId === rice.id);
    assert.equal(riceRow.planningSource, "MANUAL");
    assert.equal(riceRow.reorderPoint, 500);
    const generated = await ok("POST", "/replenishment/purchase-orders", { itemIds: [rice.id] });
    assert.equal(generated.created.length, 1);
    const draft = generated.created[0];
    assert.equal(draft.status, "DRAFT");
    assert.equal(draft.vendorId, metro.id);
    assert.equal(draft.items[0].quantityOrdered, 800 - (await central(rice.id)).quantityOnHand);
  });

  await t.test("dashboard summary", async () => {
    const dash = await ok("GET", "/reports/dashboard");
    assert.equal(dash.itemCount, 2);
    assert.ok(dash.centralStockValue > 0);
  });

  await t.test("auth is enforced when enabled", async () => {
    config.authDisabled = false;
    try {
      assert.equal((await call("GET", "/items")).status, 401);
      const jwt = require("jsonwebtoken");
      const token = jwt.sign({ name: "Store Manager", role: "admin" }, config.jwtSecret);
      const res = await fetch(`${base}/items`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200);
    } finally {
      config.authDisabled = true;
    }
  });
});
