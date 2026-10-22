const test = require("node:test");
const assert = require("node:assert/strict");
const f = require("../src/lib/forecast");
const p = require("../src/lib/planning");
const { hashEntry, canonical, GENESIS } = require("../src/services/ledger");
const { fifoValue } = require("../src/services/valuation");

const close = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

test("weighted moving average weights the newest week most", () => {
  close(f.wma([0, 0, 10, 20, 30, 40]), (10 * 1 + 20 * 2 + 30 * 3 + 40 * 4) / 10);
  assert.equal(f.wma([]), 0);
});

test("Holt follows a linear trend and damps it", () => {
  const weeks = Array.from({ length: 20 }, (_, i) => 100 + 10 * i); // +10 per week
  const fit = f.holt(weeks, { alpha: 0.5, beta: 0.3, phi: 1 });
  close(fit.forecast(1), 300, 5);
  const damped = f.holt(weeks, { alpha: 0.5, beta: 0.3, phi: 0.8 });
  assert.ok(damped.forecast(4) < fit.forecast(4), "damping slows the trend");
  assert.equal(f.holt([100, 80, 60, 40, 20, 0], { alpha: 0.9, beta: 0.9, phi: 1 }).forecast(10), 0, "never negative");
});

test("back-test picks the model that fits the series", () => {
  const trending = Array.from({ length: 16 }, (_, i) => 50 + 8 * i);
  const { errors } = f.backtest(trending);
  assert.ok(errors.HOLT < errors.SMA);
  const result = f.forecastDemand({ daily: trending.flatMap((w) => new Array(7).fill(w / 7)), horizonDays: 7 });
  assert.notEqual(result.method, "SMA");
  assert.ok(result.dailyRate * 7 > trending.at(-1) * 0.95, "forecast continues the rise");
  assert.ok(result.wmape < 0.1);
});

test("short histories fall back to the simple average", () => {
  const result = f.forecastDemand({ daily: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], horizonDays: 5 });
  assert.equal(result.method, "SMA");
  close(result.dailyRate, 5.5);
  close(result.horizonDemand, 27.5);
  assert.equal(result.wmape, null);
});

test("seasonal index needs a year and scales the forecast month", () => {
  assert.equal(f.seasonalIndex(new Array(200).fill(1), new Date(), 7), 1);
  // Demand doubles in December; forecasting the first week of December.
  const end = new Date(Date.UTC(2026, 11, 1));
  const start = end.getTime() - 365 * p.DAY_MS;
  const daily = Array.from({ length: 365 }, (_, i) => (new Date(start + (i + 0.5) * p.DAY_MS).getUTCMonth() === 11 ? 2 : 1));
  const index = f.seasonalIndex(daily, end, 7);
  close(index, 2 / (365 + 31) * 365, 0.01);
});

test("order rounding never adds more than half a pack above MAX", () => {
  // need 56 with packs of 25: rounding up (75) would overshoot MAX by 19 > 12.5, so 50 is ordered.
  assert.equal(p.suggestOrder({ onHand: 44, onOrder: 0, reorderPoint: 60, maxStock: 100, orderMultiple: 25 }).suggestedOrderQty, 50);
  // need 70: 75 overshoots by 5 only -> rounds up.
  assert.equal(p.suggestOrder({ onHand: 30, onOrder: 0, reorderPoint: 40, maxStock: 100, orderMultiple: 25 }).suggestedOrderQty, 75);
  // Rounding down would not clear the reorder point -> keep rounding up.
  assert.equal(p.suggestOrder({ onHand: 0, onOrder: 0, reorderPoint: 25, maxStock: 30, orderMultiple: 24 }).suggestedOrderQty, 48);
  assert.equal(p.suggestOrder({ onHand: 0, onOrder: 0, reorderPoint: 20, maxStock: 30, orderMultiple: 24 }).suggestedOrderQty, 24);
});

test("forecast demand drives the stock levels", () => {
  const levels = p.computeStockLevels({ dailyDemand: new Array(30).fill(10), forecastDailyDemand: 20, leadTimeDays: 3, reviewPeriodDays: 7 });
  assert.equal(levels.avgDailyUsage, 10);
  assert.equal(levels.planningDailyDemand, 20);
  assert.equal(levels.reorderPoint, 60);
  assert.equal(levels.maxStock, 200);
});

test("ledger hash is deterministic and covers every field", () => {
  const row = {
    id: "00000000-0000-0000-0000-000000000001",
    itemId: "00000000-0000-0000-0000-000000000002",
    type: "OUTLET_ISSUE",
    sourceLocation: "CENTRAL",
    destinationLocation: "00000000-0000-0000-0000-000000000003",
    quantity: 2.5,
    unitCost: "40",
    transactionValue: 100,
    closingStockCentral: 7.5,
    closingStockCentralValue: 300,
    referenceId: null,
    remarks: "x",
    createdBy: null,
    timestamp: new Date("2026-10-22T10:00:00.000Z"),
  };
  assert.match(canonical(GENESIS, row), /\u001f2\.500\u001f40\.00\u001f100\.00\u001f7\.500\u001f300\.00\u001f/);
  const h = hashEntry(GENESIS, row);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(hashEntry(GENESIS, { ...row }), h);
  assert.notEqual(hashEntry(GENESIS, { ...row, quantity: 2.501 }), h);
  assert.notEqual(hashEntry(h, row), h, "the predecessor is part of the hash");
  assert.equal(hashEntry(GENESIS, { ...row, transactionValue: -0 }), hashEntry(GENESIS, { ...row, transactionValue: 0 }));
});

test("FIFO valuation prices stock at the latest receipts", () => {
  const receipts = [{ quantity: 10, unitCost: 200 }, { quantity: 10, unitCost: 100 }]; // newest first
  assert.equal(fifoValue(15, receipts, 150), 2500);
  assert.equal(fifoValue(25, receipts, 150), 3000 + 5 * 150, "uncovered quantity at WAC");
  assert.equal(fifoValue(0, receipts, 150), 0);
});
