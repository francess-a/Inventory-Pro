// Data for the Reports page: every dataset is computed for the same date range so the
// numbers on the page always agree with each other.
const prisma = require("../db");
const { date, badRequest } = require("../lib/http");
const { DAY_MS } = require("../lib/planning");
const { buildPlan } = require("./replenishment");
const { scorecardsByVendor } = require("./vendors");
const { buildInsights } = require("./insights");

const round2 = (n) => Math.round(n * 100) / 100;
const FAST_TURNOVER = 52; // annual stock turns for an item to count as fast moving
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
 * Replays the central-store log over the range. Starts from each item's last logged
 * closing balance before `from`, then walks the range day by day, giving:
 *   - total stock value at the end of each day,
 *   - per item: opening and closing quantity/value and average quantity on hand.
 */
const replayStock = async (from, to, rangeTxns, itemIds) => {
  const opening = await prisma.$queryRaw`
    SELECT DISTINCT ON ("itemId") "itemId", "closingStockCentral", "closingStockCentralValue"
    FROM "InventoryTransaction"
    WHERE "timestamp" < ${from}
    ORDER BY "itemId", "timestamp" DESC`;
  const state = new Map(itemIds.map((id) => [id, { qty: 0, value: 0 }]));
  for (const r of opening) state.set(r.itemId, { qty: Number(r.closingStockCentral), value: Number(r.closingStockCentralValue) });
  const perItem = new Map(
    [...state].map(([id, s]) => [id, { openingQty: s.qty, openingValue: s.value, qtyDays: 0 }])
  );
  let total = [...state.values()].reduce((sum, s) => sum + s.value, 0);
  const points = [];
  let days = 0;
  let i = 0;
  for (let t = from.getTime(); t < to.getTime(); t += DAY_MS) {
    const dayEnd = Math.min(t + DAY_MS, to.getTime());
    while (i < rangeTxns.length && rangeTxns[i].timestamp.getTime() < dayEnd) {
      const tx = rangeTxns[i++];
      const current = state.get(tx.itemId) ?? { qty: 0, value: 0 };
      const next = { qty: Number(tx.closingStockCentral), value: Number(tx.closingStockCentralValue) };
      total += next.value - current.value;
      state.set(tx.itemId, next);
      if (!perItem.has(tx.itemId)) perItem.set(tx.itemId, { openingQty: 0, openingValue: 0, qtyDays: 0 });
    }
    for (const [id, s] of state) perItem.get(id).qtyDays += s.qty;
    days += 1;
    points.push({ date: dayKey(new Date(t)), value: round2(total) });
  }
  for (const [id, item] of perItem) {
    const s = state.get(id);
    Object.assign(item, { closingQty: s.qty, closingValue: s.value, avgQty: days ? item.qtyDays / days : s.qty });
  }
  return { points, perItem };
};

const analytics = async ({ from, to } = {}) => {
  const toDate = date(to, "to", { optional: true }) ?? new Date();
  const fromDate = date(from, "from", { optional: true }) ?? new Date(toDate.getTime() - 90 * DAY_MS);
  if (fromDate >= toDate) throw badRequest("from must be before to");
  const days = Math.max(1, (toDate - fromDate) / DAY_MS);

  const [txns, departments, vendors, plan, scorecards, reqLines, poCounts, items, lastIssues] = await Promise.all([
    prisma.inventoryTransaction.findMany({
      where: { timestamp: { gte: fromDate, lt: toDate } },
      select: {
        itemId: true,
        type: true,
        sourceLocation: true,
        destinationLocation: true,
        quantity: true,
        transactionValue: true,
        closingStockCentral: true,
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
    prisma.item.findMany({ select: { id: true, itemName: true, category: true, unitOfMeasure: true, costPrice: true } }),
    // Last time each item was issued, ever (for non-moving stock).
    prisma.inventoryTransaction.groupBy({ by: ["itemId"], where: { type: "OUTLET_ISSUE" }, _max: { timestamp: true } }),
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

  const { points: stockValue, perItem } = await replayStock(fromDate, toDate, txns, items.map((i) => i.id));
  const avgStockValue = stockValue.reduce((s, p) => s + p.value, 0) / (stockValue.length || 1);
  const costOfIssues = total(issues) + total(centralWaste);

  // ── Stock movement statement / cost of goods ─────────────────────────────
  // COGS = opening stock + purchases − closing stock. It is reconciled against what the log
  // says left the store (issues + central waste − adjustments); any remainder is cost
  // revaluation from weighted-average pricing and rounding.
  const itemById = new Map(items.map((i) => [i.id, i]));
  const flows = new Map(
    items.map((i) => [i.id, { purchases: 0, issues: 0, issuedQty: 0, issueCount: 0, waste: 0, allWaste: 0, adjustments: 0 }])
  );
  for (const t of txns) {
    const f = flows.get(t.itemId);
    if (!f) continue;
    if (t.type === "PURCHASE_RECEIPT") f.purchases += value(t);
    else if (t.type === "OUTLET_ISSUE") {
      f.issues += value(t);
      f.issuedQty += Number(t.quantity);
      f.issueCount += 1;
    } else if (t.type === "WASTE") {
      f.allWaste += value(t);
      if (t.sourceLocation === "CENTRAL") f.waste += value(t);
    } else if (t.type === "ADJUSTMENT") f.adjustments += value(t);
  }
  const statementRow = (name, ids) => {
    const r = { name, opening: 0, purchases: 0, issues: 0, waste: 0, adjustments: 0, closing: 0 };
    for (const id of ids) {
      const f = flows.get(id);
      const st = perItem.get(id);
      r.opening += st.openingValue;
      r.closing += st.closingValue;
      r.purchases += f.purchases;
      r.issues += f.issues;
      r.waste += f.waste;
      r.adjustments += f.adjustments;
    }
    r.cogs = r.opening + r.purchases - r.closing;
    r.revaluation = r.cogs - (r.issues + r.waste - r.adjustments);
    r.consumptionRatio = r.opening + r.purchases ? (r.cogs / (r.opening + r.purchases)) * 100 : null;
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" ? round2(v) : v]));
  };
  const byCat = new Map();
  for (const i of items) byCat.set(i.category, [...(byCat.get(i.category) ?? []), i.id]);
  const cogsByCategory = [...byCat]
    .map(([cat, ids]) => statementRow(cat.replace(/_/g, " "), ids))
    .filter((r) => r.opening || r.purchases || r.closing)
    .sort((a, b) => b.cogs - a.cogs);
  const cogs = statementRow("Total", items.map((i) => i.id));

  // ── Fast / slow / non-moving (FSN) ───────────────────────────────────────
  // Turnover = quantity issued ÷ average quantity on hand over the period. A hotel central
  // store turns perishables within days, so "fast" means stock turns at least weekly
  // (annualised turnover ≥ 52); "slow" moves less often; "non-moving" had no issues.
  const lastIssueById = new Map(lastIssues.map((r) => [r.itemId, r._max.timestamp]));
  const movement = items.map((i) => {
    const f = flows.get(i.id);
    const st = perItem.get(i.id);
    const turnover = st.avgQty > 0 ? f.issuedQty / st.avgQty : f.issuedQty > 0 ? null : 0;
    const annualTurnover = turnover === null ? null : turnover * (365 / days);
    const fsn = f.issuedQty === 0 ? "N" : annualTurnover === null || annualTurnover >= FAST_TURNOVER ? "F" : "S";
    const lastIssue = lastIssueById.get(i.id) ?? null;
    return {
      itemId: i.id,
      name: i.itemName,
      category: i.category.replace(/_/g, " "),
      unit: i.unitOfMeasure,
      fsn,
      issuedQty: round2(f.issuedQty),
      issuedValue: round2(f.issues),
      issueCount: f.issueCount,
      wasteValue: round2(f.allWaste),
      avgDailyUsage: round2(f.issuedQty / days),
      avgOnHand: round2(st.avgQty),
      turnover: turnover === null ? null : round2(turnover),
      annualTurnover: annualTurnover === null ? null : round2(annualTurnover),
      daysOfCover: f.issuedQty > 0 ? round2(st.closingQty / (f.issuedQty / days)) : null,
      closingQty: round2(st.closingQty),
      closingValue: round2(st.closingValue),
      lastIssue,
      daysSinceIssue: lastIssue ? Math.floor((toDate - lastIssue) / DAY_MS) : null,
    };
  });
  const fastMoving = movement
    .filter((m) => m.issuedQty > 0)
    .sort((a, b) => (b.annualTurnover ?? Infinity) - (a.annualTurnover ?? Infinity) || b.issuedValue - a.issuedValue)
    .slice(0, 25);
  const nonMoving = movement
    .filter((m) => m.fsn === "N" && m.closingQty > 0)
    .sort((a, b) => b.closingValue - a.closingValue)
    .slice(0, 25);
  const fsnSummary = ["F", "S", "N"].map((cls) => {
    const rows = movement.filter((m) => m.fsn === cls && (m.closingQty > 0 || m.issuedQty > 0));
    return {
      name: { F: "Fast moving", S: "Slow moving", N: "Non-moving" }[cls],
      fsn: cls,
      items: rows.length,
      value: round2(rows.reduce((s, m) => s + m.closingValue, 0)),
    };
  });

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
      openingStockValue: cogs.opening,
      closingStockValue: cogs.closing,
      cogs: cogs.cogs,
      goodsAvailable: round2(cogs.opening + cogs.purchases),
      consumptionRatio: cogs.consumptionRatio,
      nonMovingValue: round2(movement.filter((m) => m.fsn === "N").reduce((s, m) => s + m.closingValue, 0)),
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
    cogs,
    cogsByCategory,
    fastMoving,
    nonMoving,
    fsnSummary,
    insights: await buildInsights({ movement, plan, scorecards, cogs, days }),
  };
};

module.exports = { analytics, weekKey, topWithOther };
