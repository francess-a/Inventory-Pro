const prisma = require("../db");
const config = require("../config");
const { uuid } = require("../lib/http");
const {
  DAY_MS,
  dailyDemandSeries,
  weeklyTotals,
  computeStockLevels,
  suggestOrder,
  stockStatus,
  classifyAbc,
  classifyXyz,
} = require("../lib/planning");
const { openOrderQuantities, createInTx } = require("./purchasing");
const { scorecardsByVendor } = require("./vendors");

// Central-store demand: issues to outlets plus waste written off directly from central.
const demandMovements = (since) =>
  prisma.inventoryTransaction.findMany({
    where: {
      timestamp: { gte: since },
      OR: [{ type: "OUTLET_ISSUE" }, { type: "WASTE", sourceLocation: "CENTRAL" }],
    },
    select: { itemId: true, quantity: true, transactionValue: true, timestamp: true },
  });

const lastVendorByItem = async () => {
  const lines = await prisma.purchaseOrderItem.findMany({
    where: { purchaseOrder: { status: { not: "CANCELLED" } } },
    select: { itemId: true, purchaseOrder: { select: { vendorId: true, createdAt: true } } },
    orderBy: { purchaseOrder: { createdAt: "desc" } },
  });
  const result = new Map();
  for (const l of lines) if (!result.has(l.itemId)) result.set(l.itemId, l.purchaseOrder.vendorId);
  return result;
};

/**
 * Builds the replenishment plan for every active item: current stock, usage, computed
 * safety/min, reorder point and max levels, ABC/XYZ class and the quantity to order.
 */
const buildPlan = async ({ now = new Date() } = {}) => {
  const { historyDays, serviceLevelZ, reviewPeriodDays, defaultLeadTimeDays } = config.planning;
  const since = new Date(now.getTime() - historyDays * DAY_MS);
  const [items, movements, onOrder, scorecards, lastVendor] = await Promise.all([
    prisma.item.findMany({
      where: { isActive: true },
      include: { centralStock: true, outletStocks: { select: { quantityOnHand: true } } },
      orderBy: { itemName: "asc" },
    }),
    demandMovements(since),
    openOrderQuantities(),
    scorecardsByVendor(),
    lastVendorByItem(),
  ]);

  const movementsByItem = new Map();
  for (const m of movements) {
    if (!movementsByItem.has(m.itemId)) movementsByItem.set(m.itemId, []);
    movementsByItem.get(m.itemId).push(m);
  }

  const rows = items.map((item) => {
    const itemMovements = movementsByItem.get(item.id) ?? [];
    const vendorId = item.preferredVendorId ?? lastVendor.get(item.id) ?? null;
    const card = vendorId ? scorecards.get(vendorId) : null;
    const leadTimeDays = card?.avgActualLeadTimeDays ?? card?.vendor.leadTimeDays ?? defaultLeadTimeDays;
    const leadTimeSource = card?.avgActualLeadTimeDays != null ? "ACTUAL" : card ? "VENDOR_PROMISED" : "DEFAULT";
    const dailyDemand = dailyDemandSeries(itemMovements, historyDays, now);
    const computed = computeStockLevels({
      dailyDemand,
      leadTimeDays,
      leadTimeStdDev: card?.leadTimeStdDev ?? 0,
      serviceZ: serviceLevelZ,
      reviewPeriodDays,
    });
    const useComputed = item.autoPlanning && itemMovements.length > 0;
    const levels = useComputed
      ? { minStock: computed.safetyStock, reorderPoint: computed.reorderPoint, maxStock: computed.maxStock }
      : { minStock: Number(item.minStockLevel), reorderPoint: Number(item.reorderPoint), maxStock: Number(item.maxStockLevel) };
    const onHand = Number(item.centralStock?.quantityOnHand ?? 0);
    const qtyOnOrder = onOrder.get(item.id) ?? 0;
    const order = suggestOrder({ onHand, onOrder: qtyOnOrder, ...levels, orderMultiple: Number(item.orderMultiple) });
    const consumptionValue = itemMovements.reduce((sum, m) => sum + Number(m.transactionValue), 0);
    const xyz = classifyXyz(weeklyTotals(dailyDemand));

    return {
      itemId: item.id,
      sku: item.sku,
      itemName: item.itemName,
      category: item.category,
      unitOfMeasure: item.unitOfMeasure,
      costPrice: Number(item.costPrice),
      centralOnHand: onHand,
      centralValue: Number(item.centralStock?.totalValue ?? 0),
      outletOnHand: Math.round(item.outletStocks.reduce((sum, s) => sum + Number(s.quantityOnHand), 0) * 1000) / 1000,
      onOrder: qtyOnOrder,
      avgDailyUsage: Math.round(computed.avgDailyUsage * 100) / 100,
      demandStdDev: Math.round(computed.demandStdDev * 100) / 100,
      daysOfCover: computed.avgDailyUsage > 0 ? Math.round((onHand / computed.avgDailyUsage) * 10) / 10 : null,
      vendorId,
      vendorName: card?.vendor.vendorName ?? null,
      leadTimeDays: Math.round(leadTimeDays * 10) / 10,
      leadTimeSource,
      planningSource: useComputed ? "COMPUTED" : "MANUAL",
      computed: { safetyStock: computed.safetyStock, reorderPoint: computed.reorderPoint, maxStock: computed.maxStock },
      ...levels,
      status: stockStatus({ onHand, ...levels }),
      ...order,
      suggestedOrderValue: Math.round(order.suggestedOrderQty * Number(item.costPrice) * 100) / 100,
      consumptionValue: Math.round(consumptionValue * 100) / 100,
      annualConsumptionValue: Math.round((consumptionValue * 365) / historyDays),
      xyzCategory: xyz.category,
      coefficientOfVariation: xyz.coefficientOfVariation === null ? null : Math.round(xyz.coefficientOfVariation * 100) / 100,
      autoPlanning: item.autoPlanning,
      orderMultiple: Number(item.orderMultiple),
    };
  });

  const abc = classifyAbc(rows.map((r) => ({ id: r.itemId, consumptionValue: r.consumptionValue })));
  for (const row of rows) row.abcCategory = abc.get(row.itemId);
  return rows;
};

// Writes computed levels and ABC/XYZ classes back onto the items.
const recalculate = async () => {
  const rows = await buildPlan();
  await prisma.$transaction(
    rows.map((r) =>
      prisma.item.update({
        where: { id: r.itemId },
        data: {
          abcCategory: r.abcCategory,
          xyzCategory: r.xyzCategory,
          ...(r.planningSource === "COMPUTED" && {
            minStockLevel: r.minStock,
            reorderPoint: r.reorderPoint,
            maxStockLevel: r.maxStock,
          }),
        },
      })
    )
  );
  return { itemsUpdated: rows.length, levelsUpdated: rows.filter((r) => r.planningSource === "COMPUTED").length };
};

/**
 * Turns the current reorder suggestions into DRAFT purchase orders, one per vendor.
 * Unit price is the vendor's latest quoted/receipt price, falling back to average cost.
 */
const generatePurchaseOrders = async ({ itemIds } = {}) => {
  const filter = itemIds?.length ? new Set(itemIds.map((id, i) => uuid(id, `itemIds[${i}]`))) : null;
  const rows = (await buildPlan()).filter((r) => r.needsReorder && (!filter || filter.has(r.itemId)));
  const byVendor = new Map();
  const unassigned = [];
  for (const r of rows) {
    if (!r.vendorId) {
      unassigned.push({ itemId: r.itemId, itemName: r.itemName, suggestedOrderQty: r.suggestedOrderQty });
      continue;
    }
    if (!byVendor.has(r.vendorId)) byVendor.set(r.vendorId, []);
    byVendor.get(r.vendorId).push(r);
  }

  const created = [];
  for (const [vendorId, vendorRows] of byVendor) {
    const quotes = await prisma.priceQuote.findMany({
      where: { vendorId, itemId: { in: vendorRows.map((r) => r.itemId) } },
      orderBy: { recordedAt: "desc" },
    });
    const latestPrice = new Map();
    for (const q of quotes) if (!latestPrice.has(q.itemId)) latestPrice.set(q.itemId, Number(q.unitPrice));
    const po = await prisma.$transaction((tx) =>
      createInTx(tx, {
        vendorId,
        notes: "Auto-generated from reorder suggestions",
        items: vendorRows.map((r) => ({
          itemId: r.itemId,
          quantityOrdered: r.suggestedOrderQty,
          unitPrice: latestPrice.get(r.itemId) ?? r.costPrice,
        })),
      })
    );
    created.push(po);
  }
  return { created, unassigned };
};

module.exports = { buildPlan, recalculate, generatePurchaseOrders };
