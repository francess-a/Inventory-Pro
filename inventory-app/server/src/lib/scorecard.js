// Pure vendor scorecard maths.

const { DAY_MS, mean, stdDev } = require("./planning");

const WEIGHTS = { onTime: 0.3, fillRate: 0.25, quality: 0.25, price: 0.2 };

const grade = (score) => {
  if (score === null) return null;
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  return "D";
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// 100 at or below market average; loses 2 points per 1% above market, 0 at +50%.
const priceScore = (priceIndex) =>
  priceIndex === null ? null : clamp(100 * (1 - (priceIndex - 1) * 2), 0, 100);

/**
 * @param purchaseOrders  [{ status, createdAt, sentAt, expectedDeliveryAt, receivedAt,
 *                           items: [{ itemId, quantityOrdered, quantityReceived, quantityRejected, unitPrice }] }]
 * @param promisedLeadTimeDays  vendor's stated lead time
 * @param marketAverages  Map<itemId, number> benchmark price per item (all-source average)
 */
const computeScorecard = ({ purchaseOrders, promisedLeadTimeDays, marketAverages = new Map() }) => {
  const delivered = purchaseOrders.filter((po) => po.receivedAt && po.status !== "CANCELLED");

  const leadTimes = delivered.map((po) => {
    const placed = new Date(po.sentAt || po.createdAt).getTime();
    return Math.max(0, (new Date(po.receivedAt).getTime() - placed) / DAY_MS);
  });

  const withDueDate = delivered.filter((po) => po.expectedDeliveryAt);
  const onTime = withDueDate.filter(
    (po) => new Date(po.receivedAt).getTime() <= new Date(po.expectedDeliveryAt).getTime() + DAY_MS / 2
  ).length;

  let ordered = 0;
  let received = 0;
  let rejected = 0;
  let vendorSpend = 0;
  let benchmarkSpend = 0;
  for (const po of delivered) {
    for (const line of po.items) {
      ordered += Number(line.quantityOrdered);
      received += Number(line.quantityReceived);
      rejected += Number(line.quantityRejected);
      const benchmark = marketAverages.get(line.itemId);
      const qty = Number(line.quantityReceived) || Number(line.quantityOrdered);
      if (benchmark && qty > 0) {
        vendorSpend += Number(line.unitPrice) * qty;
        benchmarkSpend += benchmark * qty;
      }
    }
  }

  const metrics = {
    purchaseOrdersDelivered: delivered.length,
    promisedLeadTimeDays,
    avgActualLeadTimeDays: leadTimes.length ? mean(leadTimes) : null,
    leadTimeStdDev: leadTimes.length ? stdDev(leadTimes) : null,
    onTimeDeliveryRate: withDueDate.length ? onTime / withDueDate.length : null,
    fillRate: ordered ? received / ordered : null,
    qualityAcceptanceRate: received + rejected ? received / (received + rejected) : null,
    priceIndex: benchmarkSpend ? vendorSpend / benchmarkSpend : null,
  };

  const components = {
    onTime: metrics.onTimeDeliveryRate === null ? null : metrics.onTimeDeliveryRate * 100,
    fillRate: metrics.fillRate === null ? null : Math.min(1, metrics.fillRate) * 100,
    quality: metrics.qualityAcceptanceRate === null ? null : metrics.qualityAcceptanceRate * 100,
    price: priceScore(metrics.priceIndex),
  };

  // Weights of metrics with no data are redistributed over the ones that have data.
  let weighted = 0;
  let weightUsed = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    if (components[key] === null) continue;
    weighted += components[key] * weight;
    weightUsed += weight;
  }
  const overallScore = weightUsed ? Math.round((weighted / weightUsed) * 10) / 10 : null;

  return { ...metrics, componentScores: components, overallScore, grade: grade(overallScore) };
};

module.exports = { computeScorecard, priceScore, grade, WEIGHTS };
