// Closing stock valuation: daily snapshots into closing_stock_daily_valuation.
//
// Book value is weighted average cost (WAC): every receipt re-averages the item's unit cost,
// issues leave at that cost, and the ledger carries the running closing value. The snapshot
// also values the same closing quantity on a FIFO basis (the quantity on hand is assumed to
// come from the most recent receipts, each at its own purchase price), so the two methods
// can be compared; the difference is the revaluation effect of price changes.
//
//   closing_value_fifo = Σ over the latest receipts (newest first, until closing qty is covered)
//                        of min(remaining qty, receipt qty) × receipt price
//                        (+ any uncovered quantity at WAC, e.g. opening stock or count gains)
//   avg_daily_issue_value = (issues + central waste) value over the trailing 30 days ÷ 30
//   days_on_hand          = closing_value_wac ÷ avg_daily_issue_value

const prisma = require("../db");
const { badRequest, date } = require("../lib/http");
const { DAY_MS } = require("../lib/planning");

const TRAILING_DAYS = 30;
const MAX_RANGE_DAYS = 400;
const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;
const dayKey = (d) => d.toISOString().slice(0, 10);
const startOfDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

const parseDay = (value, name) => {
  const d = date(value, name);
  return startOfDay(d);
};

// Closing quantity/value per item as of `before` (exclusive), from the ledger.
const stateBefore = async (before) => {
  const rows = await prisma.$queryRaw`
    SELECT DISTINCT ON (item_id) item_id, closing_stock_central, closing_stock_central_value, unit_cost
    FROM stock_transaction_ledger
    WHERE "timestamp" < ${before}
    ORDER BY item_id, "timestamp" DESC, seq DESC`;
  return new Map(
    rows.map((r) => [
      r.item_id,
      { qty: Number(r.closing_stock_central), value: Number(r.closing_stock_central_value), unitCost: Number(r.unit_cost) },
    ])
  );
};

// FIFO value of `quantity` given receipts sorted newest first ({ quantity, unitCost }).
const fifoValue = (quantity, receiptsNewestFirst, fallbackUnitCost) => {
  let left = quantity;
  let value = 0;
  for (const r of receiptsNewestFirst) {
    if (left <= 0) break;
    const take = Math.min(left, r.quantity);
    value += take * r.unitCost;
    left -= take;
  }
  if (left > 0) value += left * fallbackUnitCost;
  return round2(value);
};

/**
 * Computes snapshot rows for every day in [from, to] (UTC days, inclusive) from the ledger.
 * Pure read: returns the rows without writing them.
 */
const computeSnapshots = async (from, to) => {
  const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
  if (days < 1) throw badRequest("to must not be before from");
  if (days > MAX_RANGE_DAYS) throw badRequest(`At most ${MAX_RANGE_DAYS} days per request`);
  const windowStart = new Date(from.getTime() - TRAILING_DAYS * DAY_MS);
  const end = new Date(to.getTime() + DAY_MS);

  const [opening, rows, receipts] = await Promise.all([
    stateBefore(windowStart),
    prisma.inventoryTransaction.findMany({
      where: { timestamp: { gte: windowStart, lt: end } },
      select: {
        itemId: true,
        type: true,
        sourceLocation: true,
        quantity: true,
        unitCost: true,
        transactionValue: true,
        closingStockCentral: true,
        closingStockCentralValue: true,
        timestamp: true,
      },
      orderBy: [{ timestamp: "asc" }, { seq: "asc" }],
    }),
    prisma.inventoryTransaction.findMany({
      where: { type: "PURCHASE_RECEIPT", timestamp: { lt: end } },
      select: { itemId: true, quantity: true, unitCost: true, timestamp: true },
      orderBy: [{ timestamp: "desc" }, { seq: "desc" }],
    }),
  ]);

  const receiptsByItem = new Map();
  for (const r of receipts) {
    if (!receiptsByItem.has(r.itemId)) receiptsByItem.set(r.itemId, []);
    receiptsByItem.get(r.itemId).push({ quantity: Number(r.quantity), unitCost: Number(r.unitCost), t: r.timestamp.getTime() });
  }
  const rowsByItem = new Map();
  for (const r of rows) {
    if (!rowsByItem.has(r.itemId)) rowsByItem.set(r.itemId, []);
    rowsByItem.get(r.itemId).push(r);
  }

  const totalDays = TRAILING_DAYS + days;
  const result = [];
  for (const itemId of new Set([...opening.keys(), ...rowsByItem.keys()])) {
    const state = { ...(opening.get(itemId) ?? { qty: 0, value: 0, unitCost: 0 }) };
    const itemRows = rowsByItem.get(itemId) ?? [];
    const itemReceipts = receiptsByItem.get(itemId) ?? [];
    const consumption = new Array(totalDays).fill(0);
    let i = 0;
    for (let d = 0; d < totalDays; d += 1) {
      const dayStart = windowStart.getTime() + d * DAY_MS;
      const dayEnd = dayStart + DAY_MS;
      const open = { ...state };
      const flow = { receivedQty: 0, receivedValue: 0, issuedQty: 0, issuedValue: 0, wasteQty: 0, wasteValue: 0, adjustmentQty: 0, adjustmentValue: 0 };
      let moved = false;
      while (i < itemRows.length && itemRows[i].timestamp.getTime() < dayEnd) {
        const r = itemRows[i++];
        const q = Number(r.quantity);
        const v = Number(r.transactionValue);
        if (r.type === "PURCHASE_RECEIPT") {
          flow.receivedQty += q;
          flow.receivedValue += v;
        } else if (r.type === "OUTLET_ISSUE") {
          flow.issuedQty += q;
          flow.issuedValue += v;
          consumption[d] += v;
        } else if (r.type === "WASTE" && r.sourceLocation === "CENTRAL") {
          flow.wasteQty += q;
          flow.wasteValue += v;
          consumption[d] += v;
        } else if (r.type === "ADJUSTMENT") {
          flow.adjustmentQty += q;
          flow.adjustmentValue += v;
        } else {
          continue; // outlet waste: central stock unchanged
        }
        moved = true;
        state.qty = Number(r.closingStockCentral);
        state.value = Number(r.closingStockCentralValue);
        state.unitCost = Number(r.unitCost);
      }
      if (d < TRAILING_DAYS) continue;
      if (!moved && open.qty === 0 && state.qty === 0) continue;

      let trailing = 0;
      for (let k = d - TRAILING_DAYS + 1; k <= d; k += 1) trailing += consumption[k];
      const avgDaily = trailing / TRAILING_DAYS;
      const wac = state.qty > 0 ? state.value / state.qty : state.unitCost;
      const receiptsToDate = itemReceipts.filter((r) => r.t < dayEnd);
      result.push({
        businessDate: new Date(dayStart),
        itemId,
        openingQty: round3(open.qty),
        openingValue: round2(open.value),
        receivedQty: round3(flow.receivedQty),
        receivedValue: round2(flow.receivedValue),
        issuedQty: round3(flow.issuedQty),
        issuedValue: round2(flow.issuedValue),
        wasteQty: round3(flow.wasteQty),
        wasteValue: round2(flow.wasteValue),
        adjustmentQty: round3(flow.adjustmentQty),
        adjustmentValue: round2(flow.adjustmentValue),
        closingQty: round3(state.qty),
        wacUnitCost: round2(wac),
        closingValueWac: round2(state.value),
        closingValueFifo: fifoValue(state.qty, receiptsToDate, wac),
        avgDailyIssueValue: round2(avgDaily),
        daysOnHand: avgDaily > 0 ? Math.round((state.value / avgDaily) * 10) / 10 : null,
      });
    }
  }
  return result;
};

/** Regenerates closing_stock_daily_valuation for [from, to]. Snapshots are idempotent. */
const snapshotRange = async (from, to) => {
  const rows = await computeSnapshots(from, to);
  await prisma.$transaction(
    [
      prisma.dailyValuation.deleteMany({ where: { businessDate: { gte: from, lte: to } } }),
      prisma.dailyValuation.createMany({ data: rows }),
    ],
    { timeout: 60000 }
  );
  return { from: dayKey(from), to: dayKey(to), rows: rows.length };
};

const createSnapshots = async (body = {}) => {
  const today = startOfDay(new Date());
  const to = body.to ? parseDay(body.to, "to") : new Date(today.getTime() - DAY_MS);
  const from = body.from ? parseDay(body.from, "from") : to;
  if (to > today) throw badRequest("Cannot value a future day");
  return snapshotRange(from, to);
};

/**
 * Fills in missing completed days up to yesterday: from the day after the latest snapshot,
 * or from the first ledger day (at most MAX_RANGE_DAYS back) when there are none.
 */
const ensureSnapshots = async (now = new Date()) => {
  const yesterday = new Date(startOfDay(now).getTime() - DAY_MS);
  const latest = await prisma.dailyValuation.findFirst({ orderBy: { businessDate: "desc" }, select: { businessDate: true } });
  let from;
  if (latest) {
    from = new Date(latest.businessDate.getTime() + DAY_MS);
  } else {
    const first = await prisma.inventoryTransaction.findFirst({ orderBy: { timestamp: "asc" }, select: { timestamp: true } });
    if (!first) return { rows: 0 };
    from = startOfDay(first.timestamp);
  }
  const earliest = new Date(yesterday.getTime() - (MAX_RANGE_DAYS - 1) * DAY_MS);
  if (from < earliest) from = earliest;
  if (from > yesterday) return { rows: 0 };
  return snapshotRange(from, yesterday);
};

let timer = null;
const startSnapshotScheduler = (intervalMinutes) => {
  if (!intervalMinutes || timer) return;
  const run = () => ensureSnapshots().catch((err) => console.error("valuation snapshot failed:", err.message));
  setTimeout(run, 5000).unref();
  timer = setInterval(run, intervalMinutes * 60 * 1000);
  timer.unref();
};

// Daily totals for a period (chart data) plus the per-category split of the last day.
const dailyTotals = async ({ from, to } = {}) => {
  const toDay = to ? parseDay(to, "to") : new Date(startOfDay(new Date()).getTime() - DAY_MS);
  const fromDay = from ? parseDay(from, "from") : new Date(toDay.getTime() - 89 * DAY_MS);
  const rows = await prisma.dailyValuation.groupBy({
    by: ["businessDate"],
    where: { businessDate: { gte: fromDay, lte: toDay } },
    _sum: {
      openingValue: true,
      receivedValue: true,
      issuedValue: true,
      wasteValue: true,
      adjustmentValue: true,
      closingValueWac: true,
      closingValueFifo: true,
      avgDailyIssueValue: true,
    },
    _count: { _all: true },
    orderBy: { businessDate: "asc" },
  });
  const days = rows.map((r) => {
    const s = Object.fromEntries(Object.entries(r._sum).map(([k, v]) => [k, round2(Number(v ?? 0))]));
    return {
      date: dayKey(r.businessDate),
      items: r._count._all,
      ...s,
      daysOnHand: s.avgDailyIssueValue > 0 ? Math.round((s.closingValueWac / s.avgDailyIssueValue) * 10) / 10 : null,
    };
  });
  return { from: dayKey(fromDay), to: dayKey(toDay), days };
};

// Item rows of one day's snapshot, highest value first.
const itemsOnDay = async ({ date: day } = {}) => {
  let businessDate;
  if (day) businessDate = parseDay(day, "date");
  else {
    const latest = await prisma.dailyValuation.findFirst({ orderBy: { businessDate: "desc" }, select: { businessDate: true } });
    if (!latest) return { date: null, rows: [] };
    businessDate = latest.businessDate;
  }
  const rows = await prisma.dailyValuation.findMany({
    where: { businessDate },
    include: { item: { select: { sku: true, itemName: true, category: true, unitOfMeasure: true } } },
    orderBy: { closingValueWac: "desc" },
  });
  return {
    date: dayKey(businessDate),
    rows: rows.map((r) => ({
      itemId: r.itemId,
      sku: r.item.sku,
      itemName: r.item.itemName,
      category: r.item.category,
      unitOfMeasure: r.item.unitOfMeasure,
      ...Object.fromEntries(
        Object.entries(r)
          .filter(([k]) => !["item", "itemId", "businessDate", "generatedAt"].includes(k))
          .map(([k, v]) => [k, v === null ? null : Number(v)])
      ),
    })),
  };
};

module.exports = {
  computeSnapshots,
  snapshotRange,
  createSnapshots,
  ensureSnapshots,
  startSnapshotScheduler,
  dailyTotals,
  itemsOnDay,
  fifoValue,
};
