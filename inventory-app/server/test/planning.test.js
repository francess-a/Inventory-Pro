const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("../src/lib/planning");
const { computeScorecard, priceScore } = require("../src/lib/scorecard");

const DAY = p.DAY_MS;

test("mean and sample standard deviation", () => {
  assert.equal(p.mean([2, 4, 6]), 4);
  assert.equal(p.stdDev([2, 4, 6]), 2);
  assert.equal(p.stdDev([5]), 0);
  assert.equal(p.mean([]), 0);
});

test("dailyDemandSeries buckets movements into days and ignores out-of-window ones", () => {
  const end = new Date("2026-01-10T00:00:00Z");
  const series = p.dailyDemandSeries(
    [
      { quantity: 5, timestamp: new Date(end.getTime() - 0.5 * DAY) }, // last day
      { quantity: 3, timestamp: new Date(end.getTime() - 0.2 * DAY) }, // last day
      { quantity: 7, timestamp: new Date(end.getTime() - 2.5 * DAY) }, // 3rd from last
      { quantity: 100, timestamp: new Date(end.getTime() - 10 * DAY) }, // outside window
      { quantity: 100, timestamp: new Date(end.getTime() + DAY) }, // future
    ],
    5,
    end
  );
  assert.deepEqual(series, [0, 0, 7, 0, 8]);
});

test("weeklyTotals drops the partial leading week", () => {
  const daily = [9, 9, ...new Array(14).fill(1)];
  assert.deepEqual(p.weeklyTotals(daily), [7, 7]);
});

test("computeStockLevels: constant demand and lead time gives zero safety stock", () => {
  const levels = p.computeStockLevels({ dailyDemand: new Array(30).fill(10), leadTimeDays: 3, reviewPeriodDays: 7 });
  assert.equal(levels.safetyStock, 0);
  assert.equal(levels.reorderPoint, 30);
  assert.equal(levels.maxStock, 100);
});

test("computeStockLevels: safety stock = Z * sqrt(L*sd^2 + d^2*sdL^2)", () => {
  const dailyDemand = [8, 12, 8, 12, 8, 12, 8, 12]; // mean 10, sd ≈ 2.138
  const levels = p.computeStockLevels({ dailyDemand, leadTimeDays: 4, leadTimeStdDev: 1, serviceZ: 1.65, reviewPeriodDays: 7 });
  const sd = p.stdDev(dailyDemand);
  const expectedSS = Math.ceil(1.65 * Math.sqrt(4 * sd ** 2 + 100 * 1));
  assert.equal(levels.safetyStock, expectedSS);
  assert.equal(levels.reorderPoint, Math.ceil(40 + expectedSS));
  assert.equal(levels.maxStock, Math.ceil(expectedSS + 10 * 11));
});

test("suggestOrder orders up to max only at or below the reorder point, in pack multiples", () => {
  assert.deepEqual(p.suggestOrder({ onHand: 50, onOrder: 0, reorderPoint: 40, maxStock: 100 }), {
    stockPosition: 50,
    needsReorder: false,
    suggestedOrderQty: 0,
  });
  assert.equal(p.suggestOrder({ onHand: 30, onOrder: 0, reorderPoint: 40, maxStock: 100 }).suggestedOrderQty, 70);
  assert.equal(p.suggestOrder({ onHand: 30, onOrder: 0, reorderPoint: 40, maxStock: 100, orderMultiple: 25 }).suggestedOrderQty, 75);
  // Stock already on order counts towards the position.
  assert.equal(p.suggestOrder({ onHand: 10, onOrder: 30, reorderPoint: 40, maxStock: 100 }).suggestedOrderQty, 60);
  assert.equal(p.suggestOrder({ onHand: 10, onOrder: 60, reorderPoint: 40, maxStock: 100 }).needsReorder, false);
  // Nothing to plan.
  assert.equal(p.suggestOrder({ onHand: 0, onOrder: 0, reorderPoint: 0, maxStock: 0 }).needsReorder, false);
});

test("stockStatus", () => {
  const levels = { minStock: 10, reorderPoint: 20, maxStock: 50 };
  assert.equal(p.stockStatus({ onHand: 0, ...levels }), "OUT_OF_STOCK");
  assert.equal(p.stockStatus({ onHand: 5, ...levels }), "BELOW_SAFETY_STOCK");
  assert.equal(p.stockStatus({ onHand: 20, ...levels }), "REORDER");
  assert.equal(p.stockStatus({ onHand: 30, ...levels }), "OK");
  assert.equal(p.stockStatus({ onHand: 60, ...levels }), "OVERSTOCK");
});

test("classifyAbc splits on cumulative consumption value", () => {
  const result = p.classifyAbc([
    { id: "a", consumptionValue: 700 },
    { id: "b", consumptionValue: 150 },
    { id: "c", consumptionValue: 100 },
    { id: "d", consumptionValue: 50 },
    { id: "e", consumptionValue: 0 },
  ]);
  assert.deepEqual(Object.fromEntries(result), { a: "A", b: "A", c: "B", d: "C", e: "C" });
});

test("classifyXyz uses the coefficient of variation of weekly demand", () => {
  assert.equal(p.classifyXyz([10, 10, 10, 10]).category, "X");
  assert.equal(p.classifyXyz([5, 15, 5, 15]).category, "Y");
  assert.equal(p.classifyXyz([0, 0, 40, 0]).category, "Z");
  assert.equal(p.classifyXyz([0, 0, 0]).category, "Z");
});

test("vendor scorecard metrics and weighted score", () => {
  const sent = new Date("2026-01-01T09:00:00Z");
  const po = (deliveredAfterDays, dueAfterDays, lines) => ({
    status: "RECEIVED",
    createdAt: sent,
    sentAt: sent,
    expectedDeliveryAt: new Date(sent.getTime() + dueAfterDays * DAY),
    receivedAt: new Date(sent.getTime() + deliveredAfterDays * DAY),
    items: lines,
  });
  const card = computeScorecard({
    promisedLeadTimeDays: 2,
    purchaseOrders: [
      po(2, 2, [{ itemId: "x", quantityOrdered: 10, quantityReceived: 10, quantityRejected: 0, unitPrice: 110 }]),
      po(4, 2, [{ itemId: "x", quantityOrdered: 10, quantityReceived: 8, quantityRejected: 2, unitPrice: 110 }]),
      { status: "SENT", createdAt: sent, sentAt: sent, receivedAt: null, items: [] },
    ],
    marketAverages: new Map([["x", 100]]),
  });
  assert.equal(card.purchaseOrdersDelivered, 2);
  assert.equal(card.avgActualLeadTimeDays, 3);
  assert.equal(card.onTimeDeliveryRate, 0.5);
  assert.equal(card.fillRate, 0.9);
  assert.equal(card.qualityAcceptanceRate, 0.9);
  assert.ok(Math.abs(card.priceIndex - 1.1) < 1e-9);
  // 0.3*50 + 0.25*90 + 0.25*90 + 0.2*80 = 76
  assert.equal(card.overallScore, 76);
  assert.equal(card.grade, "B");
});

test("vendor scorecard with no deliveries has no score", () => {
  const card = computeScorecard({ purchaseOrders: [], promisedLeadTimeDays: 3 });
  assert.equal(card.overallScore, null);
  assert.equal(card.grade, null);
  assert.equal(priceScore(0.9), 100);
  assert.equal(priceScore(1.5), 0);
});

test("roundUpToMultiple supports fractional pack sizes", () => {
  assert.equal(p.roundUpToMultiple(2.1, 0.5), 2.5);
  assert.equal(p.roundUpToMultiple(2.5, 0.5), 2.5);
  assert.equal(p.roundUpToMultiple(0.7, 0.25), 0.75);
  assert.equal(p.roundUpToMultiple(7, 0), 7);
  assert.equal(p.suggestOrder({ onHand: 1.2, onOrder: 0.3, reorderPoint: 2, maxStock: 4, orderMultiple: 0.5 }).suggestedOrderQty, 2.5);
});
