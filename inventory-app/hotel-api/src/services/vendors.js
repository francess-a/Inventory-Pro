const prisma = require("../db");
const { notFound, uuid, int, text } = require("../lib/http");
const { computeScorecard } = require("../lib/scorecard");
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

module.exports = { listVendors, createVendor, updateVendor, scorecardsByVendor, listScorecards, getScorecard };
