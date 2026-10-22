// Actionable suggestions for the Reports page, split by horizon:
//   daily   – what to do today, from the live state of stock, orders, requisitions and prices;
//   monthly – structural improvements from the selected period (suppliers, waste, departments).
// Each suggestion names the problem, the action and, where possible, the money involved.
// Market trends come from recorded prices (receipts, quotes, market feed), so they are as
// current as that data.
const prisma = require("../db");
const config = require("../config");
const { DAY_MS, mean } = require("../lib/planning");
const { priceComparison } = require("./market");

const PERISHABLE = new Set(["VEGETABLE", "DAIRY", "MEAT_POULTRY", "PORK", "CHICKEN", "BEEF", "BIRDS", "MUTTON", "SEAFOOD"]);
const PER_HORIZON = 20;
const round2 = (n) => Math.round(n * 100) / 100;
const money30 = (perDay) => round2(perDay * 30);
const fmt = (n) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: config.currency, maximumFractionDigits: 2 }).format(n);

// Average recorded price per item over a few windows, preferring market rates where present.
const priceWindows = async (now) => {
  const quotes = await prisma.priceQuote.findMany({
    where: { recordedAt: { gte: new Date(now - 45 * DAY_MS) } },
    select: { itemId: true, source: true, unitPrice: true, recordedAt: true },
  });
  const byItem = new Map();
  for (const q of quotes) {
    if (!byItem.has(q.itemId)) byItem.set(q.itemId, []);
    byItem.get(q.itemId).push(q);
  }
  const result = new Map();
  for (const [itemId, rows] of byItem) {
    const market = rows.filter((q) => q.source === "MARKET_FEED");
    const ref = market.length ? market : rows;
    const avg = (fromDaysAgo, toDaysAgo) => {
      const v = ref
        .filter((q) => {
          const age = (now - q.recordedAt.getTime()) / DAY_MS;
          return age <= fromDaysAgo && age > toDaysAgo;
        })
        .map((q) => Number(q.unitPrice));
      return v.length ? mean(v) : null;
    };
    result.set(itemId, { last2d: avg(2, 0), prior7d: avg(9, 2), last7d: avg(7, 0), monthAgo: avg(37, 30) });
  }
  return result;
};

const change = (now, before) => (now !== null && before ? ((now - before) / before) * 100 : null);

const dailySuggestions = async ({ movement, plan, departmentComparison, prices, now }) => {
  const out = [];
  const add = (s) => out.push({ horizon: "daily", impact: null, ...s });
  const byItem = new Map(movement.map((m) => [m.itemId, m]));
  const isShort = (r) => ["OUT_OF_STOCK", "BELOW_SAFETY_STOCK"].includes(r.status);

  // 1. Purchase orders to send today, one suggestion per supplier.
  const bySupplier = new Map();
  for (const r of plan.filter((p) => p.needsReorder)) {
    const key = r.vendorName ?? "No supplier set";
    bySupplier.set(key, [...(bySupplier.get(key) ?? []), r]);
  }
  for (const [vendor, rows] of bySupplier) {
    add({
      type: "REORDER_TODAY",
      category: "Purchasing",
      title: `Send a purchase order to ${vendor}: ${rows.length} item${rows.length > 1 ? "s" : ""} at reorder point`,
      detail: rows.map((r) => `${r.itemName} ${r.suggestedOrderQty} ${r.unitOfMeasure}`).join(", ") + ".",
      action:
        vendor === "No supplier set"
          ? "Set a preferred supplier on these items, then raise the order."
          : "On the Stock page, select these items, create the draft PO and send it.",
      impact: round2(rows.reduce((s, r) => s + r.suggestedOrderValue, 0)),
      impactLabel: "order value",
      severity: rows.some(isShort) ? "high" : "medium",
    });
  }

  // 2. Stock-outs with nothing on order and no reorder suggestion.
  for (const r of plan) {
    if (!isShort(r) || r.onOrder > 0 || r.needsReorder || !(r.avgDailyUsage > 0)) continue;
    add({
      type: "STOCKOUT_RISK",
      category: "Stock levels",
      title: `${r.itemName}: ${r.status === "OUT_OF_STOCK" ? "out of stock" : "below safety stock"} with nothing on order`,
      detail: `On hand ${r.centralOnHand} ${r.unitOfMeasure}, using about ${r.avgDailyUsage} per day.`,
      action: `Order about ${Math.ceil(r.avgDailyUsage * (r.leadTimeDays + 7))} ${r.unitOfMeasure} today.`,
      severity: "high",
    });
  }

  // 3. Late deliveries.
  const urgentIds = new Set(plan.filter(isShort).map((r) => r.itemId));
  const overdue = await prisma.purchaseOrder.findMany({
    where: { status: { in: ["SENT", "PARTIALLY_RECEIVED"] }, expectedDeliveryAt: { lt: new Date(now - DAY_MS / 2) } },
    include: { vendor: { select: { vendorName: true, phone: true } }, items: { select: { itemId: true, quantityOrdered: true, quantityReceived: true, quantityRejected: true } } },
    orderBy: { expectedDeliveryAt: "asc" },
    take: 10,
  });
  for (const po of overdue) {
    const daysLate = Math.floor((now - po.expectedDeliveryAt.getTime()) / DAY_MS);
    const hasUrgent = po.items.some((l) => urgentIds.has(l.itemId));
    if (po.status === "PARTIALLY_RECEIVED") {
      const shortLines = po.items.filter((l) => Number(l.quantityOrdered) - Number(l.quantityReceived) - Number(l.quantityRejected) > 0).length;
      add({
        type: "SHORT_DELIVERY",
        category: "Suppliers",
        title: `${po.poNumber} from ${po.vendor.vendorName}: balance of ${shortLines} line${shortLines > 1 ? "s" : ""} still not delivered`,
        detail: `Part-delivered; the rest was due ${po.expectedDeliveryAt.toISOString().slice(0, 10)} (${daysLate} day${daysLate === 1 ? "" : "s"} ago) and still counts as on order.`,
        action: `Ask ${po.vendor.vendorName} (${po.vendor.phone}) whether the balance is coming; if not, use "Close short" on the Purchases page so reorders aren't held back.`,
        severity: hasUrgent || daysLate > 7 ? "high" : "medium",
      });
      continue;
    }
    add({
      type: "OVERDUE_DELIVERY",
      category: "Suppliers",
      title: `${po.poNumber} from ${po.vendor.vendorName} is ${daysLate > 0 ? `${daysLate} day${daysLate > 1 ? "s" : ""}` : "half a day"} late`,
      detail: `Expected ${po.expectedDeliveryAt.toISOString().slice(0, 10)}; ${po.items.length} line${po.items.length > 1 ? "s" : ""}${hasUrgent ? ", including items that are short now" : ""}.`,
      action: `Call ${po.vendor.vendorName} (${po.vendor.phone}) for a delivery time; if they can't deliver today, buy the urgent items elsewhere.`,
      severity: hasUrgent ? "high" : "medium",
    });
  }

  // 4. Requisitions waiting on the store.
  const [pending, approved] = await Promise.all([
    prisma.requisition.findMany({ where: { status: "PENDING" }, select: { createdAt: true }, orderBy: { createdAt: "asc" } }),
    prisma.requisition.count({ where: { status: "APPROVED" } }),
  ]);
  if (pending.length) {
    const hours = Math.max(0, Math.round((now - pending[0].createdAt.getTime()) / 3600000));
    add({
      type: "PENDING_APPROVALS",
      category: "Requisitions",
      title: `${pending.length} requisition${pending.length > 1 ? "s" : ""} waiting for approval`,
      detail: `The oldest has waited ${hours} hour${hours === 1 ? "" : "s"}.`,
      action: "Approve or reject them on the Requisitions page so departments aren't kept waiting.",
      severity: hours >= 12 ? "high" : "medium",
    });
  }
  if (approved) {
    add({
      type: "ISSUE_APPROVED",
      category: "Requisitions",
      title: `${approved} approved requisition${approved > 1 ? "s" : ""} not yet issued`,
      detail: "Departments are waiting for this stock.",
      action: "Issue them from the central store on the Requisitions page.",
      severity: "medium",
    });
  }

  // 5. This week's price moves on perishables: buy more or less today.
  for (const [itemId, p] of prices) {
    const m = byItem.get(itemId);
    if (!m || !(m.avgDailyUsage > 0) || !PERISHABLE.has(m.category.replace(/ /g, "_"))) continue;
    const pct = change(p.last2d, p.prior7d);
    if (pct === null || Math.abs(pct) < 8) continue;
    add({
      type: pct > 0 ? "PRICE_UP_TODAY" : "PRICE_DOWN_TODAY",
      category: "Market trend",
      title: `${m.name}: market price ${pct > 0 ? "up" : "down"} ${Math.abs(pct).toFixed(1)}% vs last week`,
      detail: `About ${fmt(p.last2d)} per ${m.unit} in the last 2 days vs ${fmt(p.prior7d)} the week before.`,
      action:
        pct > 0
          ? "Buy only today's need, ask suppliers to hold last week's price, and promote dishes that use cheaper alternatives."
          : "Good day to buy: cover the next few days if storage allows, and check suppliers pass the lower price on.",
      impact: round2(Math.abs(p.last2d - p.prior7d) * m.avgDailyUsage * 3),
      impactLabel: pct > 0 ? "extra cost over 3 days" : "saving over 3 days",
    });
  }

  // 6. Perishables with more stock than they should have: use first.
  for (const r of plan) {
    if (!PERISHABLE.has(r.category) || r.status !== "OVERSTOCK" || !(r.avgDailyUsage > 0)) continue;
    add({
      type: "USE_FIRST",
      category: "Waste",
      title: `${r.itemName}: ${(r.centralOnHand / r.avgDailyUsage).toFixed(1)} days of perishable stock on hand`,
      detail: `${r.centralOnHand} ${r.unitOfMeasure} vs maximum ${r.maxStock}.`,
      action: "Issue the oldest stock first, suggest it to the kitchen as today's special, and skip the next order.",
      impact: round2((r.centralOnHand - r.maxStock) * r.costPrice),
      impactLabel: "stock at risk of spoiling",
    });
  }

  // 7. Department usage spikes: last 24 hours vs the department's daily average.
  const recent = await prisma.inventoryTransaction.groupBy({
    by: ["destinationLocation"],
    where: { type: "OUTLET_ISSUE", timestamp: { gte: new Date(now - DAY_MS), lt: new Date(now) } },
    _sum: { transactionValue: true },
  });
  const deptById = new Map(departmentComparison.map((d) => [d.id, d]));
  for (const r of recent) {
    const d = deptById.get(r.destinationLocation);
    const last24h = Number(r._sum.transactionValue ?? 0);
    if (!d || !(d.perDay > 0) || last24h < d.perDay * 1.5) continue;
    add({
      type: "DEPT_SPIKE",
      category: "Departments",
      title: `${d.name}: issues in the last 24 hours are ${(last24h / d.perDay).toFixed(1)}× its daily average`,
      detail: `${fmt(last24h)} vs an average of ${fmt(d.perDay)} per day.`,
      action: "Check with the department head whether this matches business (banquets, occupancy) or points to over-requisitioning.",
      impact: round2(last24h - d.perDay),
      impactLabel: "above the daily average",
    });
  }
  return out;
};

const monthlySuggestions = async ({ movement, plan, scorecards, days, spendItems, departmentComparison, prices }) => {
  const out = [];
  const add = (s) => out.push({ horizon: "monthly", impact: null, ...s });
  const comparison = await priceComparison({ days: 30 });
  const cmpById = new Map(comparison.map((r) => [r.id, r]));
  const planById = new Map(plan.map((r) => [r.itemId, r]));

  for (const m of movement) {
    const usagePerDay = m.avgDailyUsage;
    const cmp = cmpById.get(m.itemId);
    const p = prices.get(m.itemId);
    const trendPct = p ? change(p.last7d, p.monthAgo) : null;
    const perishable = PERISHABLE.has(m.category.replace(/ /g, "_"));

    // Paying above the best supplier / market price.
    let aboveMarket = false;
    if (cmp && usagePerDay > 0) {
      const cheapest = Math.min(...[cmp.marketPrice, cmp.bestVendorPrice].filter((v) => v !== null && v > 0));
      const gapPct = Number.isFinite(cheapest) && cmp.costPrice > 0 ? ((cmp.costPrice - cheapest) / cheapest) * 100 : 0;
      if (gapPct >= 8) {
        aboveMarket = true;
        const falling = trendPct !== null && trendPct <= -5;
        const cheaperVendor = cmp.bestVendorPrice !== null && cmp.bestVendorPrice <= cheapest + 0.01 ? cmp.bestVendor?.vendorName : null;
        add({
          type: "ABOVE_MARKET",
          category: "Purchasing",
          title: `${m.name}: our cost is ${gapPct.toFixed(1)}% above the best available price`,
          detail:
            `Average cost ${fmt(cmp.costPrice)} vs ${fmt(cheapest)}${cheaperVendor ? ` from ${cheaperVendor}` : " at market"}.` +
            (falling ? ` Part of the gap is because the market fell ${Math.abs(trendPct).toFixed(1)}% this month and older, dearer stock is still being used.` : ""),
          action:
            (cheaperVendor
              ? `Move orders to ${cheaperVendor} or use their price to renegotiate with the current supplier.`
              : "Renegotiate with the supplier using current market rates, or buy part of the need at market.") +
            (falling ? " Keep order sizes small while prices are falling." : ""),
          impact: money30(usagePerDay * (cmp.costPrice - cheapest)),
          impactLabel: "potential saving per month",
        });
      }
    }
    // Month-on-month market trend.
    if (p && trendPct !== null && usagePerDay > 0 && trendPct >= 5) {
      add({
        type: "MARKET_RISING",
        category: "Market trend",
        title: `${m.name}: market price up ${trendPct.toFixed(1)}% in a month`,
        detail: `Now about ${fmt(p.last7d)} per ${m.unit} vs ${fmt(p.monthAgo)} a month ago.`,
        action: perishable
          ? "Agree a fixed price with the supplier for the coming month, review menu costing for dishes using it, and consider substitutes."
          : "Storable item: buy up to maximum stock now at today's price, before further increases.",
        impact: money30(usagePerDay * (p.last7d - p.monthAgo)),
        impactLabel: "extra cost per month if the trend holds",
      });
    }
    if (!aboveMarket && p && trendPct !== null && usagePerDay > 0 && trendPct <= -5) {
      add({
        type: "MARKET_FALLING",
        category: "Market trend",
        title: `${m.name}: market price down ${Math.abs(trendPct).toFixed(1)}% in a month`,
        detail: `Now about ${fmt(p.last7d)} per ${m.unit} vs ${fmt(p.monthAgo)} a month ago.`,
        action: "Ask suppliers to pass the lower price on, and avoid long fixed-price commitments for now.",
        impact: money30(usagePerDay * (p.monthAgo - p.last7d)),
        impactLabel: "potential saving per month",
      });
    }
    // Waste hotspots.
    if (m.issuedValue > 0 && m.wasteValue / m.issuedValue >= 0.03) {
      add({
        type: "WASTE",
        category: "Waste",
        title: `${m.name}: waste is ${((m.wasteValue / m.issuedValue) * 100).toFixed(1)}% of issues`,
        detail: `Written off ${fmt(m.wasteValue)} vs ${fmt(m.issuedValue)} issued in the period.`,
        action: perishable
          ? "Order smaller quantities more often, enforce FIFO, and check storage temperature and handling."
          : "Check storage and handling; reduce order sizes.",
        impact: money30(m.wasteValue / days),
        impactLabel: "waste cost per month",
      });
    }
    // Non-perishable overstock (perishable overstock is a daily "use first" action).
    const planRow = planById.get(m.itemId);
    if (planRow && !perishable && planRow.status === "OVERSTOCK" && planRow.maxStock > 0) {
      const excess = planRow.centralOnHand - planRow.maxStock;
      add({
        type: "OVERSTOCK",
        category: "Stock levels",
        title: `${m.name}: ${excess.toFixed(1)} ${m.unit} above maximum stock`,
        detail: `On hand ${planRow.centralOnHand} vs maximum ${planRow.maxStock}.`,
        action: "Pause orders until stock falls to the reorder point, and review the order quantity used.",
        impact: round2(excess * planRow.costPrice),
        impactLabel: "cash tied up above maximum",
      });
    }
  }

  // Contracts for the biggest spend items.
  const allSpend = spendItems.reduce((s, r) => s + r.value, 0);
  const top10 = spendItems.slice(0, 10);
  const top10Spend = top10.reduce((s, r) => s + r.value, 0);
  if (top10.length >= 3 && allSpend > 0) {
    add({
      type: "CONTRACT_TOP_SPEND",
      category: "Purchasing",
      title: `10 items make up ${((top10Spend / allSpend) * 100).toFixed(0)}% of purchase spend`,
      detail: `${top10.slice(0, 5).map((r) => r.name).join(", ")}…`,
      action: "Negotiate monthly fixed-price or volume contracts for these items, and get competing quotes from a second supplier.",
      impact: money30((top10Spend / days) * 0.02),
      impactLabel: "saving per month from a 2% discount",
    });
  }
  // Items whose spend jumped vs the previous period.
  for (const r of spendItems.slice(0, 30)) {
    if (r.changePct === null || r.changePct < 25 || r.value - r.previous < allSpend * 0.005) continue;
    add({
      type: "SPEND_GROWTH",
      category: "Purchasing",
      title: `${r.name}: spend up ${r.changePct.toFixed(0)}% on the previous period`,
      detail: `${fmt(r.value)} vs ${fmt(r.previous)}; average price now ${fmt(r.avgPrice)} per ${r.unit}.`,
      action: "Check whether the rise is price or volume: renegotiate if price, review par levels and portions if volume.",
      impact: money30((r.value - r.previous) / days),
      impactLabel: "extra spend per month",
    });
  }
  // Departments whose consumption grew.
  const totalIssues = departmentComparison.reduce((s, d) => s + d.current, 0);
  for (const d of departmentComparison) {
    if (d.changePct === null || d.changePct < 15 || d.current < totalIssues * 0.02) continue;
    add({
      type: "DEPT_COST_GROWTH",
      category: "Departments",
      title: `${d.name}: consumption up ${d.changePct.toFixed(0)}% on the previous period`,
      detail: `${fmt(d.current)} vs ${fmt(d.previous)}; ${d.sharePct}% of all issues.`,
      action: "Review with the department head against occupancy and covers; check par levels, portion sizes and staff meals.",
      impact: money30((d.current - d.previous) / days),
      impactLabel: "extra cost per month",
    });
  }
  // Non-moving stock.
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
        action: "Raise it at the monthly supplier review, agree delivery windows, and keep a second supplier for critical items.",
      });
    }
  }
  return out;
};

/**
 * Up to PER_HORIZON suggestions per horizon, ranked by severity then money impact.
 * Severity scales with monthly cost of goods so it means the same in any size of hotel.
 */
const buildInsights = async ({ movement, plan, scorecards, cogs, days, spendItems = [], departmentComparison = [], toDate = new Date() }) => {
  const now = Math.min(Date.now(), toDate.getTime());
  const prices = await priceWindows(now);
  const [daily, monthly] = await Promise.all([
    dailySuggestions({ movement, plan, departmentComparison, prices, now }),
    monthlySuggestions({ movement, plan, scorecards, days, spendItems, departmentComparison, prices }),
  ]);
  const monthlyCogs = Math.max(1, (cogs.cogs / days) * 30);
  const rank = { high: 0, medium: 1, low: 2 };
  const finish = (list, base) =>
    list
      .map((s) => {
        if (s.severity) return s;
        if (s.impact === null) return { ...s, severity: "medium" };
        const share = s.impact / base;
        return { ...s, severity: share >= 0.01 ? "high" : share >= 0.002 ? "medium" : "low" };
      })
      .sort((a, b) => rank[a.severity] - rank[b.severity] || (b.impact ?? 0) - (a.impact ?? 0))
      .slice(0, PER_HORIZON);
  // Daily amounts cover a few days, so they are judged against a few days of cost of goods.
  return [...finish(daily, monthlyCogs / 10), ...finish(monthly, monthlyCogs)];
};

module.exports = { buildInsights, priceWindows };
