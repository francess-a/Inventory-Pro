const prisma = require("../db");
const { notFound, uuid, int, text } = require("../lib/http");
const { computeScorecard, WEIGHTS } = require("../lib/scorecard");
const { DAY_MS } = require("../lib/planning");
const { benchmarkPrices } = require("./market");

const SCORECARD_WINDOW_DAYS = 180;

const parseVendor = (body, { partial = false } = {}) => {
  const opt = { optional: partial };
  const data = {
    vendorName: text(body.vendorName, "vendorName", opt),
    contactName: text(body.contactName, "contactName", opt),
    email: text(body.email, "email", opt),
    phone: text(body.phone, "phone", opt),
    leadTimeDays: int(body.leadTimeDays, "leadTimeDays", opt),
    address: text(body.address, "address", { optional: true }),
    taxId: text(body.taxId, "taxId", { optional: true }),
    paymentTermsDays: int(body.paymentTermsDays, "paymentTermsDays", { optional: true }),
    ...(typeof body.isActive === "boolean" && { isActive: body.isActive }),
  };
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
};

const listVendors = () => prisma.vendor.findMany({ orderBy: { vendorName: "asc" } });

const createVendor = (body) => prisma.vendor.create({ data: parseVendor(body) });

const updateVendor = (id, body) =>
  prisma.vendor.update({ where: { id: uuid(id, "id") }, data: parseVendor(body, { partial: true }) });

const loadOrders = (vendorId, since) =>
  prisma.purchaseOrder.findMany({
    where: { ...(vendorId && { vendorId }), createdAt: { gte: since }, status: { not: "CANCELLED" } },
    select: {
      vendorId: true,
      status: true,
      createdAt: true,
      sentAt: true,
      expectedDeliveryAt: true,
      receivedAt: true,
      items: {
        select: { itemId: true, quantityOrdered: true, quantityReceived: true, quantityRejected: true, unitPrice: true },
      },
    },
  });

// Scorecards for every vendor, keyed by vendor id.
const scorecardsByVendor = async ({ windowDays = SCORECARD_WINDOW_DAYS } = {}) => {
  const since = new Date(Date.now() - windowDays * DAY_MS);
  const [vendors, orders, marketAverages] = await Promise.all([
    prisma.vendor.findMany(),
    loadOrders(null, since),
    benchmarkPrices({ days: windowDays }),
  ]);
  const ordersByVendor = new Map(vendors.map((v) => [v.id, []]));
  for (const po of orders) ordersByVendor.get(po.vendorId)?.push(po);
  return new Map(
    vendors.map((v) => [
      v.id,
      {
        vendor: v,
        ...computeScorecard({
          purchaseOrders: ordersByVendor.get(v.id),
          promisedLeadTimeDays: v.leadTimeDays,
          marketAverages,
        }),
      },
    ])
  );
};

const listScorecards = async () =>
  [...(await scorecardsByVendor()).values()].sort((a, b) => (b.overallScore ?? -1) - (a.overallScore ?? -1));

const getScorecard = async (id) => {
  const card = (await scorecardsByVendor()).get(uuid(id, "id"));
  if (!card) throw notFound("Vendor");
  const recentOrders = await prisma.purchaseOrder.findMany({
    where: { vendorId: id },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, poNumber: true, status: true, createdAt: true, sentAt: true, expectedDeliveryAt: true, receivedAt: true },
  });
  return { ...card, recentOrders };
};

/**
 * Writes each vendor's current scorecard into vendor_master.rating_matrix / overall_rating:
 *   { onTime, fillRate, quality, price } component scores 0-100, the weights used, the raw
 *   metrics and when it was computed. Vendors without deliveries in the window keep a null rating.
 */
const refreshRatings = async () => {
  const cards = [...(await scorecardsByVendor()).values()];
  const now = new Date();
  const round1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
  await prisma.$transaction(
    cards.map((c) =>
      prisma.vendor.update({
        where: { id: c.vendor.id },
        data: {
          ratingMatrix: {
            scores: Object.fromEntries(Object.entries(c.componentScores).map(([k, v]) => [k, round1(v)])),
            weights: WEIGHTS,
            metrics: {
              purchaseOrdersDelivered: c.purchaseOrdersDelivered,
              avgActualLeadTimeDays: round1(c.avgActualLeadTimeDays),
              onTimeDeliveryRate: c.onTimeDeliveryRate,
              fillRate: c.fillRate,
              qualityAcceptanceRate: c.qualityAcceptanceRate,
              priceIndex: c.priceIndex,
            },
            grade: c.grade,
            windowDays: SCORECARD_WINDOW_DAYS,
            computedAt: now.toISOString(),
          },
          overallRating: c.overallScore,
          ratedAt: now,
        },
      })
    )
  );
  return { vendorsRated: cards.filter((c) => c.overallScore !== null).length, vendors: cards.length };
};

module.exports = { listVendors, createVendor, updateVendor, scorecardsByVendor, listScorecards, getScorecard, refreshRatings };
