// Rule-based business insights for the Reports page. Each insight names the problem or
// opportunity, recommends an action and, where it can, estimates the money involved over
// the next 30 days (based on current usage). Market trends come from the price history
// (goods receipts, vendor quotes and market rates), so they are as current as that data.
const prisma = require("../db");
const config = require("../config");
const { DAY_MS, mean } = require("../lib/planning");
const { priceComparison } = require("./market");

const PERISHABLE = new Set(["VEGETABLE", "DAIRY", "PORK", "CHICKEN", "BEEF", "BIRDS", "MUTTON", "SEAFOOD"]);
const round2 = (n) => Math.round(n * 100) / 100;

// Market price change per item: average of the last 7 days vs the same window a month earlier.
// Uses market rates where an item has them, otherwise all price sources.
const marketTrends = async (now = Date.now()) => {
  const quotes = await prisma.priceQuote.findMany({
    where: { recordedAt: { gte: new Date(now - 45 * DAY_MS) } },
    select: { itemId: true, source: true, unitPrice: true, recordedAt: true },
  });
  const byItem = new Map();
  for (const q of quotes) {
    if (!byItem.has(q.itemId)) byItem.set(q.itemId, []);
    byItem.get(q.itemId).push(q);
  }
  const avgBetween = (rows, fromDaysAgo, toDaysAgo) => {
    const values = rows
      .filter((q) => {
        const age = (now - q.recordedAt.getTime()) / DAY_MS;
        return age <= fromDaysAgo && age > toDaysAgo;
      })
      .map((q) => Number(q.unitPrice));
    return values.length ? mean(values) : null;
  };
  const trends = new Map();
  for (const [itemId, rows] of byItem) {
    const market = rows.filter((q) => q.source === "MARKET_FEED");
    const ref = market.length ? market : rows;
    const current = avgBetween(ref, 7, 0);
    const monthAgo = avgBetween(ref, 37, 30);
    if (current !== null && monthAgo) {
      trends.set(itemId, { current, monthAgo, changePct: ((current - monthAgo) / monthAgo) * 100 });
    }
  }
  return trends;
};

const money30 = (perDay) => round2(perDay * 30);
const fmt = (n) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: config.currency, maximumFractionDigits: 2 }).format(n);

/**
 * @param movement    per-item rows from analytics (usage, stock, FSN)
 * @param plan        replenishment plan rows (status, levels, vendor)
 * @param scorecards  Map of vendor scorecards
 */
const buildInsights = async ({ movement, plan, scorecards, cogs, days }) => {
  const [trends, comparison] = await Promise.all([marketTrends(), priceComparison({ days: 30 })]);
  const planById = new Map(plan.map((r) => [r.itemId, r]));
  const cmpById = new Map(comparison.map((r) => [r.id, r]));
  const insights = [];
  const add = (insight) => insights.push({ impact: null, ...insight });

  for (const m of movement) {
    const usagePerDay = m.avgDailyUsage;
    const planRow = planById.get(m.itemId);
    const cmp = cmpById.get(m.itemId);
    const trend = trends.get(m.itemId);
    const perishable = PERISHABLE.has(m.category.replace(/ /g, "_"));

    // Market moving up: act before the next purchase.
    if (trend && usagePerDay > 0 && trend.changePct >= 5) {
      add({
        type: "MARKET_RISING",
        category: "Market trend",
        item: m.name,
        title: `${m.name}: market price up ${trend.changePct.toFixed(1)}% in a month`,
        detail: `Now about ${fmt(trend.current)} per ${m.unit} vs ${fmt(trend.monthAgo)} a month ago.`,
        action: perishable
          ? "Agree a fixed price with the supplier for the next few weeks, review menu costing for dishes using it, and consider substitutes."
          : "Storable item: buy up to maximum stock now at today's price, before further increases.",
        impact: money30(usagePerDay * (trend.current - trend.monthAgo)),
        impactLabel: "extra cost over 30 days if the trend holds",
      });
    }
    // Paying above market / above the cheapest supplier.
    let aboveMarket = false;
    if (cmp && usagePerDay > 0) {
      const cheapest = Math.min(...[cmp.marketPrice, cmp.bestVendorPrice].filter((v) => v !== null && v > 0));
      const gapPct = Number.isFinite(cheapest) && cmp.costPrice > 0 ? ((cmp.costPrice - cheapest) / cheapest) * 100 : 0;
      if (gapPct >= 8) {
        aboveMarket = true;
        const falling = trend && trend.changePct <= -5;
        const cheaperVendor = cmp.bestVendorPrice !== null && cmp.bestVendorPrice <= cheapest + 0.01 ? cmp.bestVendor?.vendorName : null;
        add({
          type: "ABOVE_MARKET",
          category: "Purchasing",
          item: m.name,
          title: `${m.name}: our cost is ${gapPct.toFixed(1)}% above the best available price`,
          detail:
            `Average cost ${fmt(cmp.costPrice)} vs ${fmt(cheapest)}${cheaperVendor ? ` from ${cheaperVendor}` : " at market"}.` +
            (falling ? ` Part of the gap is because the market fell ${Math.abs(trend.changePct).toFixed(1)}% this month and older, dearer stock is still being used.` : ""),
          action:
            (cheaperVendor
              ? `Move orders to ${cheaperVendor} or use their price to renegotiate with the current supplier.`
              : "Renegotiate with the supplier using current market rates, or buy part of the need at market.") +
            (falling ? " Keep order sizes small while prices are falling." : ""),
          impact: money30(usagePerDay * (cmp.costPrice - cheapest)),
          impactLabel: "potential saving over 30 days",
        });
      }
    }
    // Market moving down: don't lock in old prices.
    if (!aboveMarket && trend && usagePerDay > 0 && trend.changePct <= -5) {
      add({
        type: "MARKET_FALLING",
        category: "Market trend",
        item: m.name,
        title: `${m.name}: market price down ${Math.abs(trend.changePct).toFixed(1)}% in a month`,
        detail: `Now about ${fmt(trend.current)} per ${m.unit} vs ${fmt(trend.monthAgo)} a month ago.`,
        action: "Buy only what's needed until prices settle, and ask suppliers to pass the lower price on.",
        impact: money30(usagePerDay * (trend.monthAgo - trend.current)),
        impactLabel: "potential saving over 30 days",
      });
    }
    // Overstock: stock above the maximum level ties up cash and (for perishables) risks waste.
    if (planRow && planRow.status === "OVERSTOCK" && planRow.maxStock > 0) {
      const excess = planRow.centralOnHand - planRow.maxStock;
      add({
        type: "OVERSTOCK",
        category: "Stock levels",
        item: m.name,
        title: `${m.name}: ${excess.toFixed(1)} ${m.unit} above maximum stock`,
        detail: `On hand ${planRow.centralOnHand} vs maximum ${planRow.maxStock}${m.daysOfCover ? ` (${m.daysOfCover} days of cover)` : ""}.`,
        action: perishable
          ? "Pause orders, use it first (FIFO) and suggest it to the kitchen as a special to avoid spoilage."
          : "Pause orders until stock falls to the reorder point.",
        impact: round2(excess * planRow.costPrice),
        impactLabel: "cash tied up above maximum",
      });
    }
    // Stock-out risk with nothing on order.
    if (planRow && ["OUT_OF_STOCK", "BELOW_SAFETY_STOCK"].includes(planRow.status) && planRow.onOrder === 0 && usagePerDay > 0) {
      add({
        type: "STOCKOUT_RISK",
        category: "Stock levels",
        item: m.name,
        title: `${m.name}: ${planRow.status === "OUT_OF_STOCK" ? "out of stock" : "below safety stock"} with nothing on order`,
        detail: `On hand ${planRow.centralOnHand} ${m.unit}, using about ${usagePerDay} per day; lead time ${planRow.leadTimeDays} days.`,
        action: `Raise a purchase order now for about ${planRow.suggestedOrderQty || Math.ceil(usagePerDay * (planRow.leadTimeDays + 7))} ${m.unit}.`,
        severity: "high",
      });
    }
    // Waste hotspots.
    if (m.issuedValue > 0) {
      const { wasteValue } = m;
      if (wasteValue / m.issuedValue >= 0.03) {
        add({
          type: "WASTE",
          category: "Waste",
          item: m.name,
          title: `${m.name}: waste is ${((wasteValue / m.issuedValue) * 100).toFixed(1)}% of issues`,
          detail: `Written off ${fmt(wasteValue)} vs ${fmt(m.issuedValue)} issued in the period.`,
          action: perishable
            ? "Order smaller quantities more often, enforce FIFO and check storage temperature."
            : "Check storage and handling; review whether order sizes are too large.",
          impact: money30(wasteValue / days),
          impactLabel: "waste cost per 30 days",
        });
      }
    }
  }

  // Non-moving stock as one consolidated insight.
  const nonMoving = movement.filter((m) => m.fsn === "N" && m.closingValue > 0);
  if (nonMoving.length) {
    const value = round2(nonMoving.reduce((s, m) => s + m.closingValue, 0));
    add({
      type: "NON_MOVING",
      category: "Stock levels",
      title: `${nonMoving.length} non-moving item${nonMoving.length > 1 ? "s" : ""} holding ${fmt(value)} of stock`,
      detail: `No issues in the period: ${nonMoving.slice(0, 5).map((m) => m.name).join(", ")}${nonMoving.length > 5 ? "…" : ""}.`,
      action: "Stop reordering them, return to suppliers where possible, transfer to outlets that can use them, or write off obsolete stock.",
      impact: value,
      impactLabel: "cash tied up",
    });
  }

  // Unreliable suppliers.
  for (const card of scorecards.values()) {
    if (card.purchaseOrdersDelivered >= 3 && card.onTimeDeliveryRate !== null && card.onTimeDeliveryRate < 0.8) {
      add({
        type: "VENDOR_RELIABILITY",
        category: "Suppliers",
        title: `${card.vendor.vendorName}: only ${(card.onTimeDeliveryRate * 100).toFixed(0)}% of deliveries on time`,
        detail: `Average lead time ${card.avgActualLeadTimeDays?.toFixed(1)} days vs ${card.promisedLeadTimeDays} promised.`,
        action: "Raise it at the next supplier review, keep a second supplier for critical items, and order earlier (safety stock already allows for the actual lead time).",
      });
    }
  }

  // Severity: stock-outs are always high; money items scale with monthly cost of goods.
  const monthlyCogs = Math.max(1, (cogs.cogs / days) * 30);
  for (const i of insights) {
    if (i.severity) continue;
    if (i.impact === null) i.severity = "medium";
    else if (i.impact >= monthlyCogs * 0.01) i.severity = "high";
    else if (i.impact >= monthlyCogs * 0.002) i.severity = "medium";
    else i.severity = "low";
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return insights
    .sort((a, b) => rank[a.severity] - rank[b.severity] || (b.impact ?? 0) - (a.impact ?? 0))
    .slice(0, 20);
};

module.exports = { buildInsights, marketTrends };
