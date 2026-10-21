// Pure inventory-planning maths. No database access here so every formula can be
// unit tested in isolation.

const DAY_MS = 24 * 60 * 60 * 1000;

const mean = (values) =>
  values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;

// Sample standard deviation (n - 1); 0 when fewer than two observations.
const stdDev = (values) => {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
};

// Buckets dated quantities into `days` consecutive daily totals ending at `endDate`.
// Movements outside the window are ignored. Index 0 is the oldest day.
const dailyDemandSeries = (movements, days, endDate = new Date()) => {
  const series = new Array(days).fill(0);
  const end = endDate.getTime();
  const start = end - days * DAY_MS;
  for (const { quantity, timestamp } of movements) {
    const t = new Date(timestamp).getTime();
    if (t <= start || t > end) continue;
    const index = Math.min(days - 1, Math.floor((t - start) / DAY_MS));
    series[index] += quantity;
  }
  return series;
};

// Collapses a daily series into weekly totals (oldest first, partial leading week dropped).
const weeklyTotals = (dailySeries) => {
  const weeks = [];
  const offset = dailySeries.length % 7;
  for (let i = offset; i < dailySeries.length; i += 7) {
    weeks.push(dailySeries.slice(i, i + 7).reduce((sum, v) => sum + v, 0));
  }
  return weeks;
};

const roundUpToMultiple = (quantity, multiple) => {
  const m = Math.max(1, Math.floor(multiple || 1));
  return Math.ceil(quantity / m) * m;
};

/**
 * Computes stock levels for one item.
 *
 *   d   = average daily usage, σd = std-dev of daily usage
 *   L   = lead time in days,   σL = std-dev of lead time
 *   Safety stock   SS  = Z × √(L·σd² + d²·σL²)
 *   Reorder point  ROP = d·L + SS
 *   Maximum stock  MAX = SS + d·(L + R)       (R = review period in days)
 *   Order quantity      = MAX − (on hand + on order), rounded up to the pack size,
 *                         suggested only when the stock position is at or below ROP.
 */
const computeStockLevels = ({
  dailyDemand,
  leadTimeDays,
  leadTimeStdDev = 0,
  serviceZ = 1.65,
  reviewPeriodDays = 7,
}) => {
  const d = mean(dailyDemand);
  const sd = stdDev(dailyDemand);
  const L = Math.max(0, leadTimeDays);
  const safetyStock = Math.ceil(serviceZ * Math.sqrt(L * sd ** 2 + d ** 2 * leadTimeStdDev ** 2));
  const reorderPoint = Math.ceil(d * L + safetyStock);
  const maxStock = Math.max(reorderPoint, Math.ceil(safetyStock + d * (L + reviewPeriodDays)));
  return {
    avgDailyUsage: d,
    demandStdDev: sd,
    leadTimeDays: L,
    leadTimeStdDev,
    safetyStock,
    reorderPoint,
    maxStock,
  };
};

const suggestOrder = ({ onHand, onOrder, reorderPoint, maxStock, orderMultiple = 1 }) => {
  const position = onHand + onOrder;
  if (position > reorderPoint || maxStock <= position) {
    return { stockPosition: position, needsReorder: false, suggestedOrderQty: 0 };
  }
  const quantity = roundUpToMultiple(maxStock - position, orderMultiple);
  return { stockPosition: position, needsReorder: quantity > 0, suggestedOrderQty: quantity };
};

const stockStatus = ({ onHand, minStock, reorderPoint, maxStock }) => {
  if (onHand <= 0) return "OUT_OF_STOCK";
  if (onHand < minStock) return "BELOW_SAFETY_STOCK";
  if (onHand <= reorderPoint) return "REORDER";
  if (maxStock > 0 && onHand > maxStock) return "OVERSTOCK";
  return "OK";
};

// Pareto split on annual consumption value: top 80% of value = A, next 15% = B, rest = C.
const classifyAbc = (items, { aShare = 0.8, bShare = 0.95 } = {}) => {
  const total = items.reduce((sum, i) => sum + Math.max(0, i.consumptionValue), 0);
  const result = new Map();
  const sorted = [...items].sort((a, b) => b.consumptionValue - a.consumptionValue);
  let cumulative = 0;
  for (const item of sorted) {
    let category = "C";
    if (total > 0 && item.consumptionValue > 0) {
      const shareBefore = cumulative / total;
      if (shareBefore < aShare) category = "A";
      else if (shareBefore < bShare) category = "B";
    }
    cumulative += Math.max(0, item.consumptionValue);
    result.set(item.id, category);
  }
  return result;
};

// Demand variability from the coefficient of variation of weekly demand.
const classifyXyz = (weeklyDemand, { xLimit = 0.5, yLimit = 1.0 } = {}) => {
  const m = mean(weeklyDemand);
  if (m === 0) return { category: "Z", coefficientOfVariation: null };
  const cv = stdDev(weeklyDemand) / m;
  const category = cv <= xLimit ? "X" : cv <= yLimit ? "Y" : "Z";
  return { category, coefficientOfVariation: cv };
};

module.exports = {
  DAY_MS,
  mean,
  stdDev,
  dailyDemandSeries,
  weeklyTotals,
  roundUpToMultiple,
  computeStockLevels,
  suggestOrder,
  stockStatus,
  classifyAbc,
  classifyXyz,
};
