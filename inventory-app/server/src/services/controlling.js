// Cost controlling: cost of goods per outlet, outlet revenue, inventory health (days on
// hand, turnover, ageing, expiry) and the ABC-XYZ matrix.
const prisma = require("../db");
const config = require("../config");
const { badRequest, notFound, uuid, money, date, text } = require("../lib/http");
const { DAY_MS } = require("../lib/planning");
const { buildPlan } = require("./replenishment");

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const dayKey = (d) => d.toISOString().slice(0, 10);
const startOfDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

const parseRange = ({ from, to } = {}, defaultDays = 30) => {
  const toDate = to ? new Date(startOfDay(date(to, "to")).getTime() + DAY_MS) : new Date(startOfDay(new Date()).getTime() + DAY_MS);
  const fromDate = from ? startOfDay(date(from, "from")) : new Date(toDate.getTime() - defaultDays * DAY_MS);
  if (fromDate >= toDate) throw badRequest("from must be before to");
  if (toDate - fromDate > 731 * DAY_MS) throw badRequest("Range is limited to two years");
  return { fromDate, toDate };
};

// Level-1 group (Food / Beverages / Non-food) for every category code.
const categoryGroups = async () => {
  const nodes = await prisma.itemCategory.findMany({ select: { id: true, code: true, name: true, parentId: true } });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const root = (n) => (n.parentId ? root(byId.get(n.parentId)) : n);
  return new Map(nodes.map((n) => [n.code, { code: root(n).code, name: root(n).name }]));
};

// ── Outlet revenue (for cost-of-goods percentages) ─────────────────────────

const recordRevenue = async (outletId, body, recordedBy) => {
  const outletDepartmentId = uuid(outletId, "id");
  const businessDate = startOfDay(date(body.businessDate, "businessDate"));
  const revenue = money(body.revenue, "revenue");
  const outlet = await prisma.outletDepartment.findUnique({ where: { id: outletDepartmentId } });
  if (!outlet) throw notFound("Outlet");
  return prisma.outletRevenue.upsert({
    where: { outletDepartmentId_businessDate: { outletDepartmentId, businessDate } },
    create: { outletDepartmentId, businessDate, revenue, recordedBy },
    update: { revenue, recordedBy },
  });
};

const listRevenue = async (query = {}) => {
  const { fromDate, toDate } = parseRange(query);
  const rows = await prisma.outletRevenue.findMany({
    where: {
      businessDate: { gte: fromDate, lt: toDate },
      ...(query.outletDepartmentId && { outletDepartmentId: uuid(query.outletDepartmentId, "outletDepartmentId") }),
    },
    include: { outlet: { select: { code: true, name: true } } },
    orderBy: [{ businessDate: "desc" }, { outletDepartmentId: "asc" }],
  });
  return rows.map((r) => ({ ...r, businessDate: dayKey(r.businessDate), revenue: Number(r.revenue) }));
};

// ── Cost of goods per outlet ───────────────────────────────────────────────

/**
 * Cost of goods issued per outlet for a period (issues from the central store at weighted
 * average cost, i.e. the "direct issue" cost-of-goods method used by hotel F&B controls):
 *   COGS(outlet)     = Σ issue value to the outlet
 *   share %          = COGS(outlet) ÷ Σ COGS(all outlets) × 100
 *   cost % (revenue) = COGS(outlet) ÷ outlet revenue × 100      (when revenue is recorded)
 * Split by item group (Food / Beverages / Non-food), so food cost % and beverage cost % can be
 * read per outlet. Waste written off inside an outlet is shown as a memo (already in COGS).
 */
const outletCogs = async (query = {}) => {
  const { fromDate, toDate } = parseRange(query);
  const [outlets, txns, revenue, groups] = await Promise.all([
    prisma.outletDepartment.findMany(),
    prisma.inventoryTransaction.findMany({
      where: {
        timestamp: { gte: fromDate, lt: toDate },
        OR: [{ type: "OUTLET_ISSUE" }, { type: "WASTE", NOT: { sourceLocation: "CENTRAL" } }],
      },
      select: {
        type: true,
        sourceLocation: true,
        destinationLocation: true,
        transactionValue: true,
        timestamp: true,
        item: { select: { category: true } },
      },
    }),
    prisma.outletRevenue.groupBy({
      by: ["outletDepartmentId"],
      where: { businessDate: { gte: fromDate, lt: toDate } },
      _sum: { revenue: true },
    }),
    categoryGroups(),
  ]);
  const revenueBy = new Map(revenue.map((r) => [r.outletDepartmentId, Number(r._sum.revenue ?? 0)]));
  const groupNames = new Map([...groups.values()].map((g) => [g.code, g.name]));
  const rows = new Map(
    outlets.map((o) => [
      o.id,
      { outletId: o.id, code: o.code, name: o.name, outletType: o.outletType, costCenter: o.costCenter, cogs: 0, wasteMemo: 0, byGroup: {} },
    ])
  );
  for (const t of txns) {
    const value = Number(t.transactionValue);
    if (t.type === "OUTLET_ISSUE") {
      const row = rows.get(t.destinationLocation);
      if (!row) continue;
      const group = groups.get(t.item.category)?.code ?? "OTHER";
      row.cogs += value;
      row.byGroup[group] = (row.byGroup[group] ?? 0) + value;
    } else {
      const row = rows.get(t.sourceLocation);
      if (row) row.wasteMemo += value;
    }
  }
  const total = [...rows.values()].reduce((s, r) => s + r.cogs, 0);
  const result = [...rows.values()]
    .filter((r) => r.cogs > 0 || r.wasteMemo > 0 || revenueBy.has(r.outletId))
    .map((r) => {
      const rev = revenueBy.get(r.outletId) ?? null;
      return {
        ...r,
        cogs: round2(r.cogs),
        wasteMemo: round2(r.wasteMemo),
        sharePct: total > 0 ? round1((r.cogs / total) * 100) : 0,
        revenue: rev,
        costPct: rev ? round1((r.cogs / rev) * 100) : null,
        byGroup: Object.fromEntries(Object.entries(r.byGroup).map(([k, v]) => [k, round2(v)])),
      };
    })
    .sort((a, b) => b.cogs - a.cogs);

  const sumBy = (keyFn) => {
    const m = new Map();
    for (const r of result) {
      const k = keyFn(r);
      const cur = m.get(k) ?? { cogs: 0, revenue: 0, hasRevenue: false };
      cur.cogs += r.cogs;
      if (r.revenue !== null) {
        cur.revenue += r.revenue;
        cur.hasRevenue = true;
      }
      m.set(k, cur);
    }
    return [...m].map(([key, v]) => ({
      key,
      cogs: round2(v.cogs),
      sharePct: total > 0 ? round1((v.cogs / total) * 100) : 0,
      revenue: v.hasRevenue ? round2(v.revenue) : null,
      costPct: v.hasRevenue && v.revenue > 0 ? round1((v.cogs / v.revenue) * 100) : null,
    }));
  };
  const groupTotals = new Map();
  for (const r of result) for (const [g, v] of Object.entries(r.byGroup)) groupTotals.set(g, (groupTotals.get(g) ?? 0) + v);
  const totalRevenue = result.reduce((s, r) => s + (r.revenue ?? 0), 0);

  return {
    from: dayKey(fromDate),
    to: dayKey(new Date(toDate.getTime() - DAY_MS)),
    totals: {
      cogs: round2(total),
      revenue: totalRevenue > 0 ? round2(totalRevenue) : null,
      costPct: totalRevenue > 0 ? round1((total / totalRevenue) * 100) : null,
      wasteMemo: round2(result.reduce((s, r) => s + r.wasteMemo, 0)),
    },
    outlets: result,
    byOutletType: sumBy((r) => r.outletType).sort((a, b) => b.cogs - a.cogs),
    byGroup: [...groupTotals]
      .map(([code, v]) => ({ code, name: groupNames.get(code) ?? code, cogs: round2(v), sharePct: total > 0 ? round1((v / total) * 100) : 0 }))
      .sort((a, b) => b.cogs - a.cogs),
  };
};

// ── Inventory health: days on hand, turnover, ageing, expiry ───────────────

/**
 * One row per item with stock or recent movement:
 *   avgDailyConsumptionValue = (issues + central waste) value over the last 30 days ÷ 30
 *   daysOnHand (DOH)         = stock value ÷ avgDailyConsumptionValue
 *   annualTurnover           = consumption value over the last 90 days × (365 ÷ 90)
 *                              ÷ average stock value over those 90 days (daily snapshots;
 *                              the current value when no snapshots exist)
 *   avgAgeDays               = Σ(batch remaining × days since received) ÷ Σ remaining
 *   atRiskQty                = stock in batches expiring within the window that will not be used
 *                              before its expiry at the current daily usage (batches taken
 *                              earliest-expiry first, as issues are)
 *   status: EXPIRED (batches past expiry), NON_MOVING (stock, no consumption in SLOW_MOVING_DAYS),
 *           SLOW (DOH above SLOW_MOVING_DAYS), AT_RISK (atRiskQty > 0), HEALTHY
 */
const inventoryHealth = async ({ expiringWithinDays = 7 } = {}) => {
  const now = new Date();
  const today = startOfDay(now);
  const slowDays = config.valuation.slowMovingDays;
  const soon = Number(expiringWithinDays) || 7;
  const since90 = new Date(now.getTime() - 90 * DAY_MS);
  const since30 = now.getTime() - 30 * DAY_MS;
  const [items, batches, consumption, lastMoves, snapshotAvg] = await Promise.all([
    prisma.item.findMany({
      where: { isActive: true },
      select: { id: true, sku: true, itemName: true, category: true, unitOfMeasure: true, costPrice: true, centralStock: true, abcCategory: true },
    }),
    prisma.stockBatch.findMany({ where: { quantityRemaining: { gt: 0 } } }),
    prisma.inventoryTransaction.findMany({
      where: {
        timestamp: { gte: since90 },
        OR: [{ type: "OUTLET_ISSUE" }, { type: "WASTE", sourceLocation: "CENTRAL" }],
      },
      select: { itemId: true, quantity: true, transactionValue: true, timestamp: true },
    }),
    prisma.inventoryTransaction.groupBy({
      by: ["itemId"],
      where: { OR: [{ type: "OUTLET_ISSUE" }, { type: "WASTE", sourceLocation: "CENTRAL" }] },
      _max: { timestamp: true },
    }),
    prisma.dailyValuation.groupBy({
      by: ["itemId"],
      where: { businessDate: { gte: startOfDay(since90) } },
      _avg: { closingValueWac: true },
      _count: { _all: true },
    }),
  ]);
  const batchesBy = new Map();
  for (const b of batches) {
    if (!batchesBy.has(b.itemId)) batchesBy.set(b.itemId, []);
    batchesBy.get(b.itemId).push(b);
  }
  const cons90 = new Map();
  const cons30 = new Map();
  const qty30 = new Map();
  for (const t of consumption) {
    const v = Number(t.transactionValue);
    cons90.set(t.itemId, (cons90.get(t.itemId) ?? 0) + v);
    if (t.timestamp.getTime() >= since30) {
      cons30.set(t.itemId, (cons30.get(t.itemId) ?? 0) + v);
      qty30.set(t.itemId, (qty30.get(t.itemId) ?? 0) + Number(t.quantity));
    }
  }
  const lastMove = new Map(lastMoves.map((m) => [m.itemId, m._max.timestamp]));
  const avgStock = new Map(snapshotAvg.filter((s) => s._count._all >= 7).map((s) => [s.itemId, Number(s._avg.closingValueWac)]));

  const rows = items
    .map((item) => {
      const onHand = Number(item.centralStock?.quantityOnHand ?? 0);
      const value = Number(item.centralStock?.totalValue ?? 0);
      const itemBatches = batchesBy.get(item.id) ?? [];
      let remaining = 0;
      let ageWeighted = 0;
      let layerValue = 0;
      let oldest = null;
      let expiredQty = 0;
      let expiringQty = 0;
      let atRiskQty = 0;
      let nextExpiry = null;
      // Usage between now and each expiry date is shared out earliest-expiry first.
      const dailyQty = (qty30.get(item.id) ?? 0) / 30;
      let usedBefore = 0;
      for (const b of [...itemBatches].sort((x, y) => (x.expiryDate ?? Infinity) - (y.expiryDate ?? Infinity))) {
        if (!b.expiryDate) continue;
        const daysLeft = (b.expiryDate - today) / DAY_MS;
        if (daysLeft < 0 || daysLeft > soon) continue;
        const q = Number(b.quantityRemaining);
        const usable = Math.max(0, dailyQty * daysLeft - usedBefore);
        atRiskQty += Math.max(0, q - usable);
        usedBefore += Math.min(q, usable);
      }
      for (const b of itemBatches) {
        const q = Number(b.quantityRemaining);
        const age = (now - b.receivedAt) / DAY_MS;
        remaining += q;
        ageWeighted += q * age;
        layerValue += q * Number(b.unitCost);
        oldest = oldest === null ? age : Math.max(oldest, age);
        if (b.expiryDate) {
          const daysLeft = (b.expiryDate - today) / DAY_MS;
          if (daysLeft < 0) expiredQty += q;
          else if (daysLeft <= soon) expiringQty += q;
          if (daysLeft >= 0 && (nextExpiry === null || b.expiryDate < nextExpiry)) nextExpiry = b.expiryDate;
        }
      }
      const unitCost = Number(item.costPrice);
      const avgDaily = (cons30.get(item.id) ?? 0) / 30;
      const consumption90 = cons90.get(item.id) ?? 0;
      const averageStock = avgStock.get(item.id) ?? value;
      const last = lastMove.get(item.id) ?? null;
      const daysSinceIssue = last ? Math.floor((now - last) / DAY_MS) : null;
      const daysOnHand = avgDaily > 0 ? round1(value / avgDaily) : null;
      let status = "HEALTHY";
      if (onHand > 0 && (daysSinceIssue === null || daysSinceIssue >= slowDays)) status = "NON_MOVING";
      else if (daysOnHand !== null && daysOnHand > slowDays) status = "SLOW";
      if (expiredQty > 0) status = "EXPIRED";
      else if (atRiskQty > 0.0005 && status === "HEALTHY") status = "AT_RISK";
      return {
        itemId: item.id,
        sku: item.sku,
        itemName: item.itemName,
        category: item.category,
        unitOfMeasure: item.unitOfMeasure,
        abcCategory: item.abcCategory,
        onHand,
        stockValueWac: round2(value),
        stockValueLayers: round2(layerValue),
        avgDailyConsumptionValue: round2(avgDaily),
        daysOnHand,
        annualTurnover: averageStock > 0 ? round1(((consumption90 * 365) / 90) / averageStock) : null,
        avgAgeDays: remaining > 0 ? round1(ageWeighted / remaining) : null,
        oldestBatchAgeDays: oldest === null ? null : round1(oldest),
        lastIssueAt: last,
        daysSinceLastIssue: daysSinceIssue,
        expiredQty: Math.round(expiredQty * 1000) / 1000,
        expiredValue: round2(expiredQty * unitCost),
        expiringQty: Math.round(expiringQty * 1000) / 1000,
        expiringValue: round2(expiringQty * unitCost),
        atRiskQty: Math.round(atRiskQty * 1000) / 1000,
        atRiskValue: round2(atRiskQty * unitCost),
        nextExpiry: nextExpiry ? dayKey(nextExpiry) : null,
        status,
      };
    })
    .filter((r) => r.onHand > 0 || r.avgDailyConsumptionValue > 0)
    .sort((a, b) => (b.daysOnHand ?? Infinity) - (a.daysOnHand ?? Infinity) || b.stockValueWac - a.stockValueWac);

  const sum = (fn) => round2(rows.reduce((s, r) => s + fn(r), 0));
  const totalValue = sum((r) => r.stockValueWac);
  const totalDaily = sum((r) => r.avgDailyConsumptionValue);
  const total90 = [...cons90.values()].reduce((s, v) => s + v, 0);
  const totalAvgStock = items.reduce((s, i) => s + (avgStock.get(i.id) ?? Number(i.centralStock?.totalValue ?? 0)), 0);
  return {
    slowMovingDays: slowDays,
    expiringWithinDays: soon,
    summary: {
      stockValue: totalValue,
      avgDailyConsumptionValue: totalDaily,
      daysOnHand: totalDaily > 0 ? round1(totalValue / totalDaily) : null,
      annualTurnover: totalAvgStock > 0 ? round1(((total90 * 365) / 90) / totalAvgStock) : null,
      nonMovingValue: sum((r) => (r.status === "NON_MOVING" ? r.stockValueWac : 0)),
      slowMovingValue: sum((r) => (r.status === "SLOW" ? r.stockValueWac : 0)),
      expiredValue: sum((r) => r.expiredValue),
      expiringValue: sum((r) => r.expiringValue),
      atRiskValue: sum((r) => r.atRiskValue),
      itemsByStatus: rows.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {}),
    },
    items: rows,
  };
};

// ── ABC-XYZ matrix ─────────────────────────────────────────────────────────

// Control policy per cell: value class (A/B/C) × demand predictability (X/Y/Z).
const POLICY = {
  AX: "Order frequently in small lots against the forecast; low safety stock; weekly review.",
  AY: "Forecast-driven with a safety-stock buffer; review twice a week; negotiate rate contracts.",
  AZ: "High value and erratic: buy against confirmed requisitions or menus, review daily, never stockpile.",
  BX: "Automatic reorder at ROP; fortnightly review.",
  BY: "Automatic reorder with seasonal checks of min/max; fortnightly review.",
  BZ: "Order on demand with a small buffer; check before each order.",
  CX: "Bulk orders at the pack size; monthly review; minimal control effort.",
  CY: "Bulk orders with a generous buffer; monthly review.",
  CZ: "Order only on request; candidates for delisting or substitution.",
};

/**
 * ABC (value): Pareto on annualised consumption value - A = items making up the first 80%,
 * B = next 15%, C = last 5%. XYZ (volatility): coefficient of variation of weekly demand -
 * X ≤ 0.5, Y ≤ 1.0, Z above (or no demand). Cells carry counts, values and the policy.
 */
const abcXyzMatrix = async () => {
  const plan = await buildPlan();
  const cells = [];
  for (const abc of ["A", "B", "C"]) {
    for (const xyz of ["X", "Y", "Z"]) {
      const rows = plan.filter((r) => r.abcCategory === abc && r.xyzCategory === xyz);
      cells.push({
        cell: `${abc}${xyz}`,
        abc,
        xyz,
        items: rows.length,
        annualConsumptionValue: round2(rows.reduce((s, r) => s + r.annualConsumptionValue, 0)),
        stockValue: round2(rows.reduce((s, r) => s + r.centralValue, 0)),
        policy: POLICY[`${abc}${xyz}`],
        topItems: rows
          .sort((a, b) => b.annualConsumptionValue - a.annualConsumptionValue)
          .slice(0, 5)
          .map((r) => ({ itemId: r.itemId, itemName: r.itemName, annualConsumptionValue: r.annualConsumptionValue, cv: r.coefficientOfVariation })),
      });
    }
  }
  const totalValue = cells.reduce((s, c) => s + c.annualConsumptionValue, 0);
  for (const c of cells) c.valueSharePct = totalValue > 0 ? round1((c.annualConsumptionValue / totalValue) * 100) : 0;
  return {
    thresholds: { abc: { A: 0.8, B: 0.95 }, xyz: { X: 0.5, Y: 1.0 } },
    cells,
    items: plan.map((r) => ({
      itemId: r.itemId,
      sku: r.sku,
      itemName: r.itemName,
      category: r.category,
      abcCategory: r.abcCategory,
      xyzCategory: r.xyzCategory,
      annualConsumptionValue: r.annualConsumptionValue,
      coefficientOfVariation: r.coefficientOfVariation,
    })),
  };
};

// Demand forecast and reorder mechanics per item (a projection of the replenishment plan).
const forecastReport = async ({ itemId } = {}) => {
  const plan = await buildPlan();
  const rows = plan
    .filter((r) => !itemId || r.itemId === uuid(itemId, "itemId"))
    .map((r) => ({
      itemId: r.itemId,
      sku: r.sku,
      itemName: r.itemName,
      category: r.category,
      unitOfMeasure: r.unitOfMeasure,
      avgDailyUsage: r.avgDailyUsage,
      forecastDailyDemand: r.forecastDailyDemand,
      forecastMethod: r.forecastMethod,
      forecastAccuracyPct: r.forecastAccuracyPct,
      seasonalIndex: r.seasonalIndex,
      trendPerWeek: r.trendPerWeek,
      priceTrendPct: r.priceTrendPct,
      leadTimeDays: r.leadTimeDays,
      leadTimeSource: r.leadTimeSource,
      shelfLifeDays: r.shelfLifeDays,
      safetyStock: r.computed.safetyStock,
      reorderPoint: r.computed.reorderPoint,
      maxStock: r.computed.maxStock,
      planningAdjustments: r.planningAdjustments,
      planningSource: r.planningSource,
      centralOnHand: r.centralOnHand,
      onOrder: r.onOrder,
      stockPosition: r.stockPosition,
      needsReorder: r.needsReorder,
      suggestedOrderQty: r.suggestedOrderQty,
      suggestedOrderValue: r.suggestedOrderValue,
    }));
  if (itemId && rows.length === 0) throw notFound("Item");
  return rows;
};

module.exports = {
  outletCogs,
  recordRevenue,
  listRevenue,
  inventoryHealth,
  abcXyzMatrix,
  forecastReport,
  categoryGroups,
  POLICY,
};
