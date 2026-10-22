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
  // Real migrations (not db push) so the triggers and CHECK constraints are in place.
  execSync("npx prisma migrate deploy", {
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
    assert.equal(Number(afterFirst.quantityOnHand), 50);
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
    assert.equal(Number(item.centralStock.quantityOnHand), 90);
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
    assert.equal(Number(direct.items[0].quantityReceived), 18);
    assert.equal(Number((await central(rice.id)).quantityOnHand), 68);
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
    assert.equal(Number(issuedOnion.quantityIssued), 25);
    assert.equal(issuedOnion.unitCost, "44");
    assert.equal(issuedOnion.issuedValue, "1100");
    assert.equal(Number((await central(onion.id)).quantityOnHand), 65);

    const outlet = await ok("GET", `/stock/outlets?outletDepartmentId=${kitchen.id}`);
    assert.equal(Number(outlet.find((s) => s.itemId === onion.id).quantityOnHand), 25);

    const tx = await ok("GET", `/transactions?itemId=${onion.id}&type=OUTLET_ISSUE`);
    assert.equal(Number(tx[0].closingStockCentral), 65);
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
    const before = Number((await central(rice.id)).quantityOnHand);
    assert.equal((await call("POST", `/requisitions/${req.id}/issue`, {})).status, 409);
    assert.equal(Number((await central(rice.id)).quantityOnHand), before);
    assert.equal((await ok("GET", `/requisitions/${req.id}`)).status, "APPROVED");
  });

  await t.test("waste and stock adjustments", async () => {
    await ok("POST", "/stock/waste", { itemId: onion.id, quantity: 5, reason: "Spoiled" });
    assert.equal(Number((await central(onion.id)).quantityOnHand), 60);
    await ok("POST", "/stock/waste", { itemId: onion.id, quantity: 5, location: kitchen.id, reason: "Burnt" });
    const outlet = await ok("GET", `/stock/outlets?outletDepartmentId=${kitchen.id}`);
    assert.equal(Number(outlet.find((s) => s.itemId === onion.id).quantityOnHand), 20);
    assert.equal((await call("POST", "/stock/waste", { itemId: onion.id, quantity: 500, location: kitchen.id, reason: "x" })).status, 409);
    await ok("POST", "/stock/adjustments", { itemId: onion.id, quantityChange: -2, reason: "Count variance" });
    assert.equal(Number((await central(onion.id)).quantityOnHand), 58);
    assert.equal((await call("POST", "/stock/adjustments", { itemId: onion.id, quantityChange: -100, reason: "x" })).status, 409);
  });

  await t.test("fractional quantities for weighed goods", async () => {
    const butter = await ok("POST", "/items", {
      sku: "BUT", barcode: "333", itemName: "Butter", category: "DAIRY", unitOfMeasure: "kg", orderMultiple: 0.5,
    });
    await ok("POST", "/purchase-orders/direct", {
      vendorId: metro.id,
      items: [{ itemId: butter.id, quantityOrdered: 2.5, unitPrice: 500 }],
    });
    assert.equal((await central(butter.id)).quantityOnHand, "2.5");
    assert.equal((await central(butter.id)).totalValue, "1250");

    let req = await ok("POST", "/requisitions", {
      outletDepartmentId: kitchen.id,
      items: [{ itemId: butter.id, quantityRequested: 0.75 }],
    });
    req = await ok("POST", `/requisitions/${req.id}/approve`);
    req = await ok("POST", `/requisitions/${req.id}/issue`, {});
    assert.equal(req.items[0].quantityIssued, "0.75");
    assert.equal(req.items[0].issuedValue, "375");
    assert.equal((await central(butter.id)).quantityOnHand, "1.75");

    const tooPrecise = await call("POST", "/requisitions", {
      outletDepartmentId: kitchen.id,
      items: [{ itemId: butter.id, quantityRequested: 1.2345 }],
    });
    assert.equal(tooPrecise.status, 400);
    await ok("POST", "/stock/waste", { itemId: butter.id, quantity: 0.25, reason: "Melted" });
    assert.equal((await central(butter.id)).quantityOnHand, "1.5");
  });

  await t.test("department consumption report", async () => {
    const report = await ok("GET", "/reports/department-consumption");
    assert.equal(report.departments.length, 1);
    // 25 kg onion @ 44 + 10 kg rice @ 87.35 ((50*90 + 18*80) / 68) + 0.75 kg butter @ 500
    assert.equal(report.departments[0].totalValue, "2348.5");
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
    // Back-date heavy onion usage so the plan computes levels above current stock. The ledger is
    // hash-chained, so the synthetic history goes through the same append as real movements.
    const { appendEntry } = require("../src/services/ledger");
    const now = Date.now();
    await prisma.$transaction(async (tx) => {
      for (let i = 0; i < 30; i += 1) {
        await appendEntry(tx, {
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
        });
      }
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
    assert.equal(result.itemsUpdated, 3);
    const updated = await ok("GET", `/items/${onion.id}`);
    assert.equal(Number(updated.reorderPoint), row.reorderPoint);
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
    assert.equal(Number(draft.items[0].quantityOrdered), 800 - Number((await central(rice.id)).quantityOnHand));
  });

  await t.test("short-closing a partly delivered order stops it counting as on order", async () => {
    let po = await ok("POST", "/purchase-orders", { vendorId: metro.id, items: [{ itemId: rice.id, quantity: 40, unitPrice: 85 }] });
    assert.equal((await call("POST", `/purchase-orders/${po.id}/close`)).status, 409, "DRAFT cannot be closed short");
    po = await ok("POST", `/purchase-orders/${po.id}/send`);
    po = await ok("POST", `/purchase-orders/${po.id}/receive`, { lines: [{ poItemId: po.items[0].id, quantityReceived: 30 }] });
    assert.equal(po.status, "PARTIALLY_RECEIVED");
    const onOrder = async () => (await ok("GET", "/replenishment")).find((r) => r.itemId === rice.id).onOrder;
    assert.equal(await onOrder(), 10);
    po = await ok("POST", `/purchase-orders/${po.id}/close`, { reason: "supplier out of stock" });
    assert.equal(po.status, "RECEIVED");
    assert.match(po.notes, /Closed short \(supplier out of stock\)/);
    assert.equal(await onOrder(), 0);
  });

  await t.test("reports analytics agree with the transaction log", async () => {
    const report = await ok("GET", "/reports/analytics");
    const sum = (rows) => Math.round(rows.reduce((s, r) => s + r.value, 0) * 100) / 100;
    // 25 kg onion @ 44 + 10 kg rice @ 87.35 + 0.75 kg butter @ 500 + 1 kg rice issued in the role test
    assert.ok(report.kpis.issuesValue > 2348);
    assert.equal(sum(report.byDepartment), report.kpis.issuesValue);
    assert.equal(sum(report.spendByVendor), report.kpis.purchasesValue);
    assert.equal(sum(report.topWaste), report.kpis.wasteValue); // fewer than 10 waste items here, so the top list is complete
    assert.ok(report.stockValue.length >= 89);
    assert.equal(report.stockValue[report.stockValue.length - 1].value, report.kpis.currentStockValue);
    assert.equal(report.abc.reduce((s, a) => s + a.items, 0), 3);
    assert.ok(report.weekly.some((w) => w.partial));
    assert.equal((await call("GET", "/reports/analytics?from=2026-02-01&to=2026-01-01")).status, 400);

    // COGS statement: opening + purchases − closing, reconciling with what left the store.
    const c = report.cogs;
    assert.equal(c.opening, 0); // everything in this test happened inside the window
    assert.ok(Math.abs(c.opening + c.purchases - c.closing - c.cogs) < 0.02);
    // The replenishment test inserted 30 back-dated issue records (330 kg onion @ 44) that never
    // moved stock; the reconciliation must surface exactly that gap (plus rounding only).
    assert.ok(Math.abs(c.revaluation + 330 * 44) < 1, `unexplained difference ${c.revaluation}`);
    assert.equal(report.kpis.cogs, c.cogs);
    assert.equal(report.kpis.closingStockValue, report.kpis.currentStockValue);
    const catSum = report.cogsByCategory.reduce((s, r) => s + r.cogs, 0);
    assert.ok(Math.abs(catSum - c.cogs) < 0.05);

    // FSN: every item with stock or movement is classified once; fast list is ranked by turnover.
    assert.equal(report.fsnSummary.reduce((s, f) => s + f.items, 0), 3);
    const turns = report.fastMoving.map((m) => m.annualTurnover ?? Infinity);
    assert.deepEqual(turns, [...turns].sort((a, b) => b - a));
    assert.ok(report.fastMoving.length <= 25 && report.nonMoving.length <= 25);
    assert.ok(Array.isArray(report.insights));
    for (const i of report.insights) {
      assert.ok(["high", "medium", "low"].includes(i.severity) && i.title && i.action);
      assert.ok(["daily", "monthly"].includes(i.horizon));
    }
    for (const h of ["daily", "monthly"]) assert.ok(report.insights.filter((i) => i.horizon === h).length <= 20);
    // Approved requisitions waiting to be issued show up as a daily action.
    assert.ok(report.insights.some((i) => i.type === "PENDING_APPROVALS" || i.type === "ISSUE_APPROVED" || i.type === "REORDER_TODAY"));

    // Spend lists: most descending, least ascending, both from the same receipts.
    const spend = report.topSpend.map((r) => r.value);
    assert.deepEqual(spend, [...spend].sort((a, b) => b - a));
    const least = report.leastSpend.map((r) => r.value);
    assert.deepEqual(least, [...least].sort((a, b) => a - b));
    assert.equal(sum(report.topSpend), report.kpis.purchasesValue); // fewer than 30 items here
    assert.equal(report.topSpend[report.topSpend.length - 1].cumulativePct, 100);

    // Department comparison: this period sums to total issues; no previous data in a fresh database.
    assert.equal(sum(report.departmentComparison.map((d) => ({ value: d.current }))), report.kpis.issuesValue);
    assert.equal(report.previousPeriod.complete, false);
    assert.ok(report.departmentComparison.every((d) => d.changePct === null && d.previous === null));
    const heat = report.departmentCategory;
    assert.equal(heat.rows.length, report.departmentComparison.length);
    assert.equal(sum(heat.rows.flatMap((r) => r.values.map((v) => ({ value: v })))), report.kpis.issuesValue);
  });

  await t.test("indent vs received report", async () => {
    const report = await ok("GET", "/reports/indent-vs-received");
    const s = report.summary;
    // Every line is in exactly one outcome.
    assert.equal(Object.values(s.states).reduce((a, b) => a + b, 0), s.lines);
    assert.equal(report.lines.length, s.lines);
    // Received value ties back to the issue records.
    const issued = report.lines.filter((l) => l.status === "ISSUED");
    assert.ok(Math.abs(issued.reduce((a, l) => a + l.receivedValue, 0) - s.receivedValue) < 0.01);
    // The 1000 kg onion requisition was approved but never issued (not enough stock): still waiting.
    const onionWaiting = report.lines.find((l) => l.item === "Onion" && l.requested === 1000);
    assert.equal(onionWaiting.state, "WAITING");
    // Departments add up to the total; per-item quantities balance.
    assert.ok(Math.abs(report.byDepartment.reduce((a, d) => a + d.indentValue, 0) - s.indentValue) < 0.01);
    for (const i of report.byItem) {
      assert.ok(Math.abs(i.requested - i.received - i.shortQty - i.waitingQty) < 0.001, i.name);
    }
    // Filters narrow the lines.
    const waiting = await ok("GET", "/reports/indent-vs-received?status=APPROVED");
    assert.ok(waiting.lines.every((l) => l.status === "APPROVED"));
    assert.equal((await call("GET", "/reports/indent-vs-received?from=2026-02-01&to=2026-01-01")).status, 400);
  });

  await t.test("dashboard summary", async () => {
    const dash = await ok("GET", "/reports/dashboard");
    assert.equal(dash.itemCount, 3);
    assert.ok(dash.centralStockValue > 0);
  });

  // ── Central store architecture ───────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const daysFromNow = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  let chicken;
  let saffron;

  await t.test("multi-tier categories", async () => {
    const tree = await ok("GET", "/categories");
    const chickenNode = tree.find((c) => c.code === "CHICKEN");
    assert.equal(chickenNode.path, "Food › Meat & poultry › Chicken");
    assert.equal(chickenNode.level, 3);
    assert.ok(tree.find((c) => c.code === "DRY_GOODS").parentCode === "GROCERY");
    const cheese = await ok("POST", "/categories", { code: "cheese", name: "Cheese", parentCode: "DAIRY" });
    assert.equal(cheese.level, 3);
    assert.equal(cheese.isPerishable, true, "inherits perishable from its parent");
    assert.equal((await call("POST", "/categories", { code: "BRIE", name: "Brie", parentCode: "CHEESE" })).status, 400, "max three levels");
    assert.equal((await call("POST", "/items", { sku: "G1", barcode: "g1", itemName: "Group item", category: "FOOD", unitOfMeasure: "kg" })).status, 400);
    const food = await ok("GET", "/items?category=FOOD");
    assert.deepEqual(food.map((i) => i.sku).sort(), ["BUT", "ONI", "RIC"]);
  });

  await t.test("goods receipt records batch, expiry and invoice on the inward ledger", async () => {
    chicken = await ok("POST", "/items", { sku: "CHK", barcode: "444", itemName: "Chicken", category: "CHICKEN", unitOfMeasure: "kg" });
    saffron = await ok("POST", "/items", { sku: "SAF", barcode: "555", itemName: "Saffron", category: "GROCERY", unitOfMeasure: "g", shelfLifeDays: 400 });
    const po1 = await ok("POST", "/purchase-orders", { vendorId: farm.id, items: [{ itemId: chicken.id, quantityOrdered: 30, unitPrice: 200 }] });
    await ok("POST", `/purchase-orders/${po1.id}/send`);
    const line = po1.items[0];
    // Already expired goods cannot be accepted.
    const expired = await call("POST", `/purchase-orders/${po1.id}/receive`, {
      lines: [{ poItemId: line.id, quantityReceived: 10, expiryDate: daysFromNow(-1) }],
    });
    assert.equal(expired.status, 400);
    await ok("POST", `/purchase-orders/${po1.id}/receive`, {
      invoiceNumber: "FARM-881",
      invoiceDate: today,
      lines: [
        { poItemId: line.id, quantityReceived: 10, quantityRejected: 2, rejectionReason: "Smell", batchNumber: "LATE-EXP", expiryDate: daysFromNow(3) },
      ],
    });
    // Second delivery without an expiry date: defaulted from the category shelf life (3 days).
    await ok("POST", `/purchase-orders/${po1.id}/receive`, { lines: [{ poItemId: line.id, quantityReceived: 10, batchNumber: "EARLY-EXP", expiryDate: daysFromNow(1) }] });
    await ok("POST", `/purchase-orders/${po1.id}/receive`, { lines: [{ poItemId: line.id, quantityReceived: 8 }] });

    const inward = await ok("GET", `/ledger/inward?purchaseOrderId=${po1.id}`);
    assert.equal(inward.length, 3);
    const first = inward.find((r) => r.batchNumber === "LATE-EXP");
    assert.equal(first.invoiceNumber, "FARM-881");
    assert.equal(first.invoiceDate.slice(0, 10), today);
    assert.equal(Number(first.quantityReceived), 10);
    assert.equal(Number(first.quantityRejected), 2);
    assert.equal(first.lineValue, "2000");
    assert.equal(first.receivedBy, "system");
    assert.ok(first.transactionId);
    const defaulted = inward.find((r) => !["LATE-EXP", "EARLY-EXP"].includes(r.batchNumber));
    assert.match(defaulted.batchNumber, /^GRN-/);
    assert.equal(defaulted.expiryDate.slice(0, 10), daysFromNow(3));

    const batches = await ok("GET", `/ledger/batches?itemId=${chicken.id}`);
    assert.deepEqual(batches.map((b) => b.batchNumber), ["EARLY-EXP", "LATE-EXP", defaulted.batchNumber]);
    assert.equal((await ok("GET", `/ledger/batches?expiringWithinDays=1`)).length, 1);
  });

  await t.test("issues consume batches first-expiry-first-out and write the issue ledger", async () => {
    let req = await ok("POST", "/requisitions", { outletDepartmentId: kitchen.id, items: [{ itemId: chicken.id, quantityRequested: 12 }] });
    req = await ok("POST", `/requisitions/${req.id}/approve`);
    req = await ok("POST", `/requisitions/${req.id}/issue`, {});
    const issues = await ok("GET", `/ledger/issues?requisitionId=${req.id}`);
    assert.equal(issues.length, 1);
    assert.match(issues[0].issueNumber, /^ISS-/);
    assert.equal(issues[0].issueValue, "2400");
    assert.deepEqual(
      issues[0].batchAllocations.map((a) => [a.batchNumber, a.quantity]),
      [["EARLY-EXP", 10], ["LATE-EXP", 2]]
    );
    const batches = await ok("GET", `/ledger/batches?itemId=${chicken.id}`);
    assert.equal(batches.reduce((sum, b) => sum + Number(b.quantityRemaining), 0), 16);
    assert.equal(Number((await central(chicken.id)).quantityOnHand), 16);
  });

  await t.test("simultaneous issue requests deduct stock exactly once", async () => {
    let req = await ok("POST", "/requisitions", {
      outletDepartmentId: kitchen.id,
      items: [{ itemId: chicken.id, quantityRequested: 3 }, { itemId: rice.id, quantityRequested: 1 }],
    });
    req = await ok("POST", `/requisitions/${req.id}/approve`);
    const before = { chicken: Number((await central(chicken.id)).quantityOnHand), rice: Number((await central(rice.id)).quantityOnHand) };
    const results = await Promise.all(Array.from({ length: 6 }, () => call("POST", `/requisitions/${req.id}/issue`, {})));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409, 409, 409]);
    assert.equal(Number((await central(chicken.id)).quantityOnHand), before.chicken - 3);
    assert.equal(Number((await central(rice.id)).quantityOnHand), before.rice - 1);
    assert.equal((await ok("GET", `/ledger/issues?requisitionId=${req.id}`)).length, 2);
  });

  await t.test("an idempotency key makes a retried issue return the original result", async () => {
    let req = await ok("POST", "/requisitions", { outletDepartmentId: kitchen.id, items: [{ itemId: chicken.id, quantityRequested: 2 }] });
    req = await ok("POST", `/requisitions/${req.id}/approve`);
    const before = Number((await central(chicken.id)).quantityOnHand);
    const send = (key) =>
      fetch(`${base}/requisitions/${req.id}/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: "{}",
      }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const first = await send("issue-abc");
    const retry = await send("issue-abc");
    assert.equal(first.status, 200);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.replayed, true);
    assert.equal(retry.body.id, first.body.id);
    assert.equal((await send("another-key")).status, 409);
    assert.equal(Number((await central(chicken.id)).quantityOnHand), before - 2);
  });

  await t.test("the ledgers are append-only", async () => {
    const updates = {
      stock_transaction_ledger: "remarks = 'x'",
      purchase_inward_ledger: "received_by = 'x'",
      issue_requisition_ledger: "issued_by = 'x'",
      audit_log: "path = 'x'",
    };
    for (const [table, set] of Object.entries(updates)) {
      await assert.rejects(prisma.$executeRawUnsafe(`UPDATE ${table} SET ${set}`), /append-only/, table);
      await assert.rejects(prisma.$executeRawUnsafe(`DELETE FROM ${table}`), /append-only/, table);
      await assert.rejects(prisma.$executeRawUnsafe(`TRUNCATE ${table} CASCADE`), /append-only/, table);
    }
    // Stock can never go negative, even bypassing the application.
    await assert.rejects(prisma.$executeRawUnsafe(`UPDATE central_stock SET quantity_on_hand = -1 WHERE item_id = '${chicken.id}'`), /central_stock_quantity_check/);
  });

  await t.test("hash chain verification detects tampering", async () => {
    const report = await ok("GET", "/ledger/verify");
    assert.equal(report.valid, true, JSON.stringify(report.problems));
    assert.equal(report.entries, await prisma.inventoryTransaction.count());
    assert.ok(report.heads.every((h) => /^[0-9a-f]{64}$/.test(h.entryHash)));

    // A database administrator edits a historical row with the trigger switched off…
    const row = (await ok("GET", `/ledger/transactions?itemId=${chicken.id}&limit=500`)).rows.at(-1);
    const edit = (sql) =>
      prisma.$transaction([
        prisma.$executeRawUnsafe("ALTER TABLE stock_transaction_ledger DISABLE TRIGGER stock_transaction_ledger_append_only"),
        prisma.$executeRawUnsafe(sql),
        prisma.$executeRawUnsafe("ALTER TABLE stock_transaction_ledger ENABLE TRIGGER stock_transaction_ledger_append_only"),
      ]);
    await edit(`UPDATE stock_transaction_ledger SET quantity = quantity + 1 WHERE id = '${row.id}'`);
    const tampered = await ok("GET", `/ledger/verify?itemId=${chicken.id}`);
    assert.equal(tampered.valid, false);
    assert.deepEqual(tampered.problems.map((p) => [p.problem, p.seq]), [["TAMPERED", row.seq]]);
    await edit(`UPDATE stock_transaction_ledger SET quantity = quantity - 1 WHERE id = '${row.id}'`);
    assert.equal((await ok("GET", `/ledger/verify?itemId=${chicken.id}`)).valid, true);
  });

  await t.test("daily closing valuation: WAC book value and FIFO comparison", async () => {
    const po = await ok("POST", "/purchase-orders/direct", { vendorId: metro.id, items: [{ itemId: saffron.id, quantityOrdered: 10, unitPrice: 100 }] });
    assert.equal(po.status, "RECEIVED");
    await ok("POST", "/purchase-orders/direct", { vendorId: metro.id, items: [{ itemId: saffron.id, quantityOrdered: 10, unitPrice: 200 }] });
    let req = await ok("POST", "/requisitions", { outletDepartmentId: kitchen.id, items: [{ itemId: saffron.id, quantityRequested: 5 }] });
    req = await ok("POST", `/requisitions/${req.id}/approve`);
    await ok("POST", `/requisitions/${req.id}/issue`, {});

    const created = await ok("POST", "/valuation/snapshots", { from: today, to: today });
    assert.ok(created.rows >= 5);
    const day = await ok("GET", `/valuation/items?date=${today}`);
    const s = day.rows.find((r) => r.itemId === saffron.id);
    assert.equal(s.receivedQty, 20);
    assert.equal(s.issuedQty, 5);
    assert.equal(s.closingQty, 15);
    assert.equal(s.wacUnitCost, 150);
    assert.equal(s.closingValueWac, 2250);
    assert.equal(s.closingValueFifo, 2500, "10 @ 200 + 5 @ 100");
    assert.equal(s.avgDailyIssueValue, 25, "750 issued ÷ 30 days");
    assert.equal(s.daysOnHand, 90);
    // Every item's snapshot agrees with central stock.
    for (const r of day.rows) {
      const c = await central(r.itemId);
      assert.equal(r.closingQty, Number(c.quantityOnHand), r.sku);
      assert.equal(r.closingValueWac, Number(c.totalValue), r.sku);
    }
    // Regenerating is idempotent.
    assert.equal((await ok("POST", "/valuation/snapshots", { from: today, to: today })).rows, created.rows);
    const totals = await ok("GET", `/valuation/daily?from=${today}&to=${today}`);
    assert.equal(totals.days.length, 1);
    assert.equal(totals.days[0].closingValueWac, Math.round(day.rows.reduce((t, r) => t + r.closingValueWac, 0) * 100) / 100);
    assert.equal((await call("POST", "/valuation/snapshots", { from: daysFromNow(1), to: daysFromNow(1) })).status, 400);
  });

  await t.test("cost of goods per outlet with revenue percentages", async () => {
    const bar = await ok("POST", "/departments", { mainOutlet: "BAR" });
    assert.equal(bar.code, "BAR");
    assert.equal(bar.outletType, "BAR");
    assert.equal(kitchen.code, "FB-TANDOOR");
    assert.equal(kitchen.outletType, "KITCHEN");

    const issues = await ok("GET", `/transactions?type=OUTLET_ISSUE&limit=500`);
    const kitchenCogs = issues.filter((t) => t.destinationLocation === kitchen.id).reduce((sum, t) => sum + Number(t.transactionValue), 0);
    await ok("PUT", `/departments/${kitchen.id}/revenue`, { businessDate: today, revenue: 50000 });
    await ok("PUT", `/departments/${kitchen.id}/revenue`, { businessDate: today, revenue: 40000 }); // corrected, not added
    const report = await ok("GET", `/reports/outlet-cogs?from=${daysFromNow(-60)}&to=${today}`);
    const row = report.outlets.find((o) => o.outletId === kitchen.id);
    assert.equal(row.cogs, Math.round(kitchenCogs * 100) / 100);
    assert.equal(row.revenue, 40000);
    assert.equal(row.costPct, Math.round((kitchenCogs / 40000) * 1000) / 10);
    assert.equal(row.sharePct, 100);
    assert.equal(report.byGroup.find((g) => g.code === "FOOD").cogs, row.cogs);
    assert.equal((await ok("GET", `/revenue?from=${today}&to=${today}`))[0].revenue, 40000);
  });

  await t.test("inventory health: days on hand, turnover and ageing", async () => {
    const health = await ok("GET", "/reports/inventory-health");
    const s = health.items.find((r) => r.itemId === saffron.id);
    assert.equal(s.onHand, 15);
    assert.equal(s.stockValueWac, 2250);
    assert.equal(s.stockValueLayers, 2500, "remaining batches at their own cost");
    assert.equal(s.avgDailyConsumptionValue, 25);
    assert.equal(s.daysOnHand, 90);
    assert.equal(s.status, "SLOW");
    assert.ok(s.avgAgeDays < 1);
    assert.ok(health.summary.stockValue > 0);
    assert.ok(health.summary.slowMovingValue >= 2250);
    // 11 kg of chicken expires within 3 days but the kitchen uses ~0.6 kg a day: most of it is at risk.
    const c = health.items.find((r) => r.itemId === chicken.id);
    assert.equal(c.status, "AT_RISK");
    assert.equal(c.expiringQty, 11);
    const dailyQty = 17 / 30; // 12 + 3 + 2 kg issued today
    assert.ok(Math.abs(c.atRiskQty - (11 - dailyQty * 3)) < 0.01, `${c.atRiskQty}`);
  });

  await t.test("ABC-XYZ matrix and demand forecast", async () => {
    const matrix = await ok("GET", "/reports/abc-xyz");
    assert.equal(matrix.cells.length, 9);
    assert.equal(matrix.cells.reduce((n, c) => n + c.items, 0), matrix.items.length);
    assert.ok(matrix.cells.every((c) => c.policy));
    const forecast = await ok("GET", `/reports/forecast?itemId=${chicken.id}`);
    assert.equal(forecast.length, 1);
    assert.equal(forecast[0].forecastMethod, "SMA");
    assert.equal(forecast[0].shelfLifeDays, 3);
    assert.ok(forecast[0].reorderPoint >= forecast[0].safetyStock);
  });

  await t.test("vendor rating matrix is refreshed from the scorecard", async () => {
    const result = await ok("POST", "/vendors/ratings/refresh");
    assert.ok(result.vendorsRated >= 1);
    const vendor = (await ok("GET", "/vendors")).find((v) => v.id === farm.id);
    assert.ok(vendor.ratingMatrix.scores.quality < 100, "rejections lower the quality score");
    assert.ok(Number(vendor.overallRating) > 0);
    assert.ok(vendor.ratedAt);
  });

  await t.test("every change request is in the audit log", async () => {
    const log = await ok("GET", "/audit/log?limit=500");
    const issue = log.rows.find((r) => r.path.endsWith("/issue") && r.statusCode === 200);
    assert.ok(issue);
    assert.equal(issue.method, "POST");
    assert.equal(issue.actorName, "system");
    assert.ok(issue.entityId);
    assert.ok(log.rows.some((r) => r.statusCode === 409), "refused requests are logged too");
    assert.ok(log.rows.every((r) => r.method !== "GET"));
  });

  await t.test("register, login and user management", async () => {
    config.authDisabled = false;
    const withToken = (token) => async (method, url, body) => {
      const res = await fetch(base + url, {
        method,
        headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    const anon = withToken(null);
    try {
      // First account becomes admin; later self-registrations are store staff whatever they ask for.
      const first = await anon("POST", "/auth/register", { name: "Owner", email: "Owner@Hotel.test", password: "secret-123" });
      assert.equal(first.status, 201);
      assert.equal(first.body.user.role, "admin");
      assert.equal(first.body.user.email, "owner@hotel.test");
      const second = await anon("POST", "/auth/register", { name: "Clerk", email: "clerk@hotel.test", password: "secret-456", role: "admin" });
      assert.equal(second.body.user.role, "user");
      assert.equal((await anon("POST", "/auth/register", { name: "Dup", email: "clerk@hotel.test", password: "secret-456" })).status, 409);
      assert.equal((await anon("POST", "/auth/register", { name: "Short", email: "s@hotel.test", password: "123" })).status, 400);

      assert.equal((await anon("POST", "/auth/login", { email: "clerk@hotel.test", password: "wrong-pass" })).status, 401);
      const login = await anon("POST", "/auth/login", { email: "CLERK@hotel.test", password: "secret-456" });
      assert.equal(login.status, 200);
      const clerk = withToken(login.body.token);
      const owner = withToken(first.body.token);
      assert.equal((await clerk("GET", "/auth/me")).body.user.email, "clerk@hotel.test");

      // Only admins manage users.
      assert.equal((await clerk("GET", "/users")).status, 403);
      const list = await owner("GET", "/users");
      assert.equal(list.body.length, 2);
      assert.ok(!("passwordHash" in list.body[0]));
      const promoted = await owner("PATCH", `/users/${second.body.user.id}`, { role: "approver" });
      assert.equal(promoted.body.role, "approver");
      assert.equal((await owner("PATCH", `/users/${first.body.user.id}`, { role: "user" })).status, 400);
      const created = await owner("POST", "/users", { name: "Chef", email: "chef@hotel.test", password: "kitchen-01", role: "user" });
      assert.equal(created.status, 201);

      // Deactivated users cannot log in.
      await owner("PATCH", `/users/${created.body.id}`, { isActive: false });
      assert.equal((await anon("POST", "/auth/login", { email: "chef@hotel.test", password: "kitchen-01" })).status, 401);
    } finally {
      config.authDisabled = true;
    }
  });

  await t.test("auth and roles are enforced when enabled", async () => {
    config.authDisabled = false;
    const jwt = require("jsonwebtoken");
    const as = (role) => async (method, url, body) => {
      const token = jwt.sign({ name: `${role} user`, role }, config.jwtSecret);
      const res = await fetch(base + url, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    const staff = as("user");
    const approverUser = as("approver");
    try {
      assert.equal((await call("GET", "/items")).status, 401);
      assert.equal((await staff("GET", "/items")).status, 200);

      // Staff can raise and follow requisitions, but not approve or issue them.
      const req = await staff("POST", "/requisitions", { outletDepartmentId: kitchen.id, items: [{ itemId: rice.id, quantity: 1 }] });
      assert.equal(req.status, 201);
      assert.equal(req.body.requestedBy, "user user");
      assert.equal((await staff("POST", `/requisitions/${req.body.id}/approve`)).status, 403);
      const approved = await approverUser("POST", `/requisitions/${req.body.id}/approve`);
      assert.equal(approved.status, 200);
      assert.equal(approved.body.approvedBy, "approver user");
      assert.equal((await staff("POST", `/requisitions/${req.body.id}/issue`, {})).status, 403);
      assert.equal((await approverUser("POST", `/requisitions/${req.body.id}/issue`, {})).status, 200);
      assert.equal((await staff("GET", `/requisitions/${req.body.id}`)).body.status, "ISSUED");

      // Staff only reach requisitions, the item and department pickers and the indent report.
      for (const path of ["/requisitions", "/departments", "/reports/indent-vs-received"]) {
        assert.equal((await staff("GET", path)).status, 200, path);
      }
      for (const path of [
        "/reports/dashboard", "/reports/analytics", "/replenishment", "/purchase-orders", "/vendors", "/market/comparison",
        "/transactions", "/stock/outlets", "/reports/outlet-cogs", "/reports/inventory-health", "/valuation/daily",
        "/ledger/transactions", "/ledger/verify", "/ledger/inward", "/audit/log", "/categories",
      ]) {
        assert.equal((await staff("GET", path)).status, 403, path);
      }
      for (const [method, path, body] of [
        ["POST", "/stock/waste", { itemId: rice.id, quantity: 1, reason: "x" }],
        ["POST", "/stock/adjustments", { itemId: rice.id, quantityChange: 1, reason: "x" }],
        ["POST", "/purchase-orders", {}],
        ["POST", "/market/prices", { itemId: rice.id, unitPrice: 1 }],
        ["POST", "/vendors", { vendorName: "X" }],
        ["POST", "/replenishment/recalculate"],
      ]) {
        assert.equal((await staff(method, path, body)).status, 403, `${method} ${path}`);
      }
      // Approvers keep their access; the API audit log is for admins only.
      assert.equal((await approverUser("GET", "/reports/dashboard")).status, 200);
      assert.equal((await approverUser("GET", "/ledger/verify")).status, 200);
      assert.equal((await approverUser("GET", "/audit/log")).status, 403);
    } finally {
      config.authDisabled = true;
    }
  });
});
