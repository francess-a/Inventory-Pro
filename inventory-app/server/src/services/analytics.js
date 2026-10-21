// Data for the Reports page: every dataset is computed for the same date range so the
// numbers on the page always agree with each other.
const prisma = require("../db");
const { date, badRequest } = require("../lib/http");
const { DAY_MS } = require("../lib/planning");
const { buildPlan } = require("./replenishment");
const { scorecardsByVendor } = require("./vendors");

const round2 = (n) => Math.round(n * 100) / 100;
const dayKey = (d) => d.toISOString().slice(0, 10);

// Monday of the week containing `d` (UTC), as YYYY-MM-DD.
const weekKey = (d) => {
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return dayKey(monday);
};

const departmentName = (dept) =>
  dept.subDepartment === "NONE" ? dept.mainOutlet.replace(/_/g, " ") : `${dept.mainOutlet} / ${dept.subDepartment.replace(/_/g, " ")}`;

// Keeps the largest `keep` entries and folds the remainder into "Other".
const topWithOther = (entries, keep) => {
  const sorted = [...entries].sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, keep);
  const rest = sorted.slice(keep).reduce((sum, e) => sum + e.value, 0);
  return rest > 0 ? [...top, { name: "Other", value: round2(rest) }] : top;
};

const sumBy = (rows, keyFn, valueFn) => {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    map.set(key, (map.get(key) ?? 0) + valueFn(row));
  }
  return map;
};

/**
 * Central stock value at the end of each day in the range. Starts from each item's last
 * logged closing value before the range, then replays the transaction log.
 */
const dailyStockValue = async (from, to, rangeTxns) => {
  const opening = await prisma.$queryRaw`
    SELECT DISTINCT ON ("itemId") "itemId", "closingStockCentralValue"
    FROM "InventoryTransaction"
    WHERE "timestamp" < ${from}
    ORDER BY "itemId", "timestamp" DESC`;
  const valueByItem = new Map(opening.map((r) => [r.itemId, Number(r.closingStockCentralValue)]));
  let total = [...valueByItem.values()].reduce((s, v) => s + v, 0);
  const points = [];
  let i = 0;
  for (let t = from.getTime(); t < to.getTime(); t += DAY_MS) {
    const dayEnd = Math.min(t + DAY_MS, to.getTime());
    while (i < rangeTxns.length && rangeTxns[i].timestamp.getTime() < dayEnd) {
      const tx = rangeTxns[i++];
      const next = Number(tx.closingStockCentralValue);
      total += next - (valueByItem.get(tx.itemId) ?? 0);
      valueByItem.set(tx.itemId, next);
    }
    points.push({ date: dayKey(new Date(t)), value: round2(total) });
  }
  return points;
};

const analytics = async ({ from, to } = {}) => {
  const toDate = date(to, "to", { optional: true }) ?? new Date();
  const fromDate = date(from, "from", { optional: true }) ?? new Date(toDate.getTime() - 90 * DAY_MS);
  if (fromDate >= toDate) throw badRequest("from must be before to");
  const days = Math.max(1, (toDate - fromDate) / DAY_MS);

  const [txns, departments, vendors, plan, scorecards, reqLines, poCounts] = await Promise.all([
    prisma.inventoryTransaction.findMany({
      where: { timestamp: { gte: fromDate, lt: toDate } },
      select: {
        itemId: true,
        type: true,
        sourceLocation: true,
        destinationLocation: true,
        quantity: true,
        transactionValue: true,
        closingStockCentralValue: true,
        timestamp: true,
        item: { select: { itemName: true, category: true, unitOfMeasure: true } },
      },
      orderBy: { timestamp: "asc" },
    }),
    prisma.outletDepartment.findMany(),
    prisma.vendor.findMany({ select: { id: true, vendorName: true } }),
    buildPlan(),
    scorecardsByVendor(),
    prisma.requisitionItem.findMany({
      where: { requisition: { status: "ISSUED", issuedAt: { gte: fromDate, lt: toDate } } },
      select: { quantityRequested: true, quantityIssued: true, requisition: { select: { outletDepartmentId: true } } },
    }),
    prisma.purchaseOrder.groupBy({
      by: ["status"],
      where: { createdAt: { gte: fromDate, lt: toDate } },
      _count: { _all: true },
    }),
  ]);

  const value = (t) => Number(t.transactionValue);
  const receipts = txns.filter((t) => t.type === "PURCHASE_RECEIPT");
  const issues = txns.filter((t) => t.type === "OUTLET_ISSUE");
  const waste = txns.filter((t) => t.type === "WASTE");
  const centralWaste = waste.filter((t) => t.sourceLocation === "CENTRAL");
  const total = (rows) => round2(rows.reduce((s, t) => s + value(t), 0));

  // Weekly flows: purchases in, issues out, waste.
  const weeks = new Map();
  const bump = (t, field) => {
    const key = weekKey(t.timestamp);
    const row = weeks.get(key) ?? { week: key, purchases: 0, issues: 0, waste: 0 };
    row[field] += value(t);
    weeks.set(key, row);
  };
  receipts.forEach((t) => bump(t, "purchases"));
  issues.forEach((t) => bump(t, "issues"));
  waste.forEach((t) => bump(t, "waste"));
  // A week is partial when the date range cuts it; charts plot full weeks only so the
  // edges don't look like slumps, tables keep every week.
  const weekly = [...weeks.values()]
    .sort((a, b) => a.week.localeCompare(b.week))
    .map((w) => {
      const start = new Date(`${w.week}T00:00:00Z`);
      const partial = start < fromDate || start.getTime() + 7 * DAY_MS > toDate.getTime();
      return { week: w.week, partial, purchases: round2(w.purchases), issues: round2(w.issues), waste: round2(w.waste) };
    });

  const stockValue = await dailyStockValue(fromDate, toDate, txns);
  const avgStockValue = stockValue.reduce((s, p) => s + p.value, 0) / (stockValue.length || 1);
  const costOfIssues = total(issues) + total(centralWaste);

  const deptById = new Map(departments.map((d) => [d.id, departmentName(d)]));
  const byDepartment = [...sumBy(issues, (t) => t.destinationLocation, value)]
    .map(([id, v]) => ({ name: deptById.get(id) ?? "Unknown", value: round2(v) }))
    .sort((a, b) => b.value - a.value);

  const byCategory = topWithOther(
    [...sumBy(issues, (t) => t.item.category, value)].map(([c, v]) => ({ name: c.replace(/_/g, " "), value: round2(v) })),
    5
  );

  const vendorById = new Map(vendors.map((v) => [v.id, v.vendorName]));
  const spendByVendor = [...sumBy(receipts, (t) => t.sourceLocation.replace("VENDOR:", ""), value)]
    .map(([id, v]) => ({ name: vendorById.get(id) ?? "Unknown", value: round2(v) }))
    .sort((a, b) => b.value - a.value);

  const itemRows = (rows) =>
    [...sumBy(rows, (t) => t.itemId, value)]
      .map(([id, v]) => {
        const item = rows.find((t) => t.itemId === id).item;
        const quantity = rows.filter((t) => t.itemId === id).reduce((s, t) => s + Number(t.quantity), 0);
        return { name: item.itemName, value: round2(v), quantity: round2(quantity), unit: item.unitOfMeasure };
      })
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);

  const abc = ["A", "B", "C"].map((cls) => {
    const rows = plan.filter((r) => r.abcCategory === cls);
    return { name: `Class ${cls}`, value: round2(rows.reduce((s, r) => s + r.annualConsumptionValue, 0)), items: rows.length };
  });

  const STATUS_LABELS = {
    OUT_OF_STOCK: "Out of stock",
    BELOW_SAFETY_STOCK: "Below safety stock",
    REORDER: "At reorder point",
    OK: "OK",
    OVERSTOCK: "Overstock",
  };
  const stockStatus = Object.entries(STATUS_LABELS)
    .map(([status, name]) => ({ status, name, value: plan.filter((r) => r.status === status).length }))
    .filter((s) => s.value > 0);

  const vendorPerformance = [...scorecards.values()]
    .filter((c) => c.purchaseOrdersDelivered > 0)
    .map((c) => ({
      name: c.vendor.vendorName,
      onTime: c.onTimeDeliveryRate === null ? null : round2(c.onTimeDeliveryRate * 100),
      fillRate: c.fillRate === null ? null : round2(Math.min(1, c.fillRate) * 100),
      score: c.overallScore,
    }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  const fulfilment = [...sumBy(reqLines, (l) => l.requisition.outletDepartmentId, (l) => Number(l.quantityRequested))]
    .map(([id, requested]) => {
      const issued = reqLines
        .filter((l) => l.requisition.outletDepartmentId === id)
        .reduce((s, l) => s + Number(l.quantityIssued), 0);
      return { name: deptById.get(id) ?? "Unknown", value: requested ? round2((issued / requested) * 100) : null };
    })
    .sort((a, b) => a.value - b.value);

  const requested = reqLines.reduce((s, l) => s + Number(l.quantityRequested), 0);
  const issuedQty = reqLines.reduce((s, l) => s + Number(l.quantityIssued), 0);

  return {
    from: fromDate,
    to: toDate,
    kpis: {
      purchasesValue: total(receipts),
      issuesValue: total(issues),
      wasteValue: total(waste),
      wastePctOfIssues: total(issues) ? round2((total(waste) / total(issues)) * 100) : null,
      currentStockValue: stockValue.length ? stockValue[stockValue.length - 1].value : 0,
      averageStockValue: round2(avgStockValue),
      // Annualised: cost of goods issued over the period ÷ average stock value.
      inventoryTurnover: avgStockValue ? round2((costOfIssues / avgStockValue) * (365 / days)) : null,
      daysOfInventory: costOfIssues ? round2(avgStockValue / (costOfIssues / days)) : null,
      requisitionFillRate: requested ? round2((issuedQty / requested) * 100) : null,
      purchaseOrders: poCounts.reduce((s, r) => s + r._count._all, 0),
      itemsToReorder: plan.filter((r) => r.needsReorder).length,
    },
    weekly,
    stockValue,
    byDepartment,
    byCategory,
    spendByVendor,
    topConsumption: itemRows(issues),
    topWaste: itemRows(waste),
    abc,
    stockStatus,
    vendorPerformance,
    fulfilment,
  };
};

module.exports = { analytics, weekKey, topWithOther };
