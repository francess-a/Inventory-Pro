// Price history and market comparison. Prices come from three sources:
//   PURCHASE_RECEIPT  recorded automatically on every goods receipt
//   VENDOR_QUOTE      quotations entered by the purchase team
//   MARKET_FEED       wholesale/market rates, entered manually or pulled from MARKET_FEED_URL
const prisma = require("../db");
const config = require("../config");
const { badRequest, notFound, uuid, money, text, oneOf, date, nonEmptyArray } = require("../lib/http");
const { DAY_MS, mean } = require("../lib/planning");

const SOURCES = ["PURCHASE_RECEIPT", "VENDOR_QUOTE", "MARKET_FEED"];

const pctChange = (from, to) => (from && to !== null ? ((to - from) / from) * 100 : null);

const recordPrice = async (body) => {
  const itemId = uuid(body.itemId, "itemId");
  const vendorId = body.vendorId ? uuid(body.vendorId, "vendorId") : null;
  const source = oneOf(body.source ?? (vendorId ? "VENDOR_QUOTE" : "MARKET_FEED"), "source", SOURCES);
  if (source === "VENDOR_QUOTE" && !vendorId) throw badRequest("vendorId is required for a VENDOR_QUOTE");
  return prisma.priceQuote.create({
    data: {
      itemId,
      vendorId,
      source,
      unitPrice: money(body.unitPrice, "unitPrice"),
      market: text(body.market, "market", { optional: true }),
      recordedAt: date(body.recordedAt, "recordedAt", { optional: true }) ?? new Date(),
    },
  });
};

// Bulk import keyed by SKU, used by the feed sync and CSV-style uploads.
const importMarketPrices = async (rows, { defaultMarket } = {}) => {
  nonEmptyArray(rows, "prices");
  const skus = [...new Set(rows.map((r) => String(r.sku)))];
  const items = await prisma.item.findMany({ where: { sku: { in: skus } }, select: { id: true, sku: true } });
  const idBySku = new Map(items.map((i) => [i.sku, i.id]));
  const data = [];
  const unknownSkus = [];
  for (const [i, row] of rows.entries()) {
    const itemId = idBySku.get(String(row.sku));
    if (!itemId) {
      unknownSkus.push(row.sku);
      continue;
    }
    data.push({
      itemId,
      source: "MARKET_FEED",
      unitPrice: money(row.unitPrice ?? row.price, `prices[${i}].unitPrice`),
      market: text(row.market, `prices[${i}].market`, { optional: true }) ?? defaultMarket ?? null,
      recordedAt: date(row.recordedAt, `prices[${i}].recordedAt`, { optional: true }) ?? new Date(),
    });
  }
  if (data.length) await prisma.priceQuote.createMany({ data });
  return { imported: data.length, unknownSkus };
};

// Pulls the configured market feed. Expected response: [{ sku, unitPrice, market?, recordedAt? }].
const syncMarketFeed = async () => {
  if (!config.marketFeed.url) throw badRequest("MARKET_FEED_URL is not configured");
  const response = await fetch(config.marketFeed.url, {
    headers: config.marketFeed.apiKey ? { Authorization: `Bearer ${config.marketFeed.apiKey}` } : {},
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Market feed responded with HTTP ${response.status}`);
  const body = await response.json();
  return importMarketPrices(Array.isArray(body) ? body : body.prices ?? [], { defaultMarket: "feed" });
};

let feedTimer = null;
const startMarketFeedPolling = () => {
  if (!config.marketFeed.url || feedTimer) return;
  const tick = () =>
    syncMarketFeed()
      .then((r) => console.log(`Market feed: imported ${r.imported} prices`))
      .catch((err) => console.error("Market feed sync failed:", err.message));
  tick();
  feedTimer = setInterval(tick, config.marketFeed.intervalMinutes * 60 * 1000);
  feedTimer.unref();
};

/**
 * Benchmark price per item over the window: the average market rate where one
 * exists, otherwise the average of all vendor quotes and receipt prices.
 */
const benchmarkPrices = async ({ days = 90 } = {}) => {
  const rows = await prisma.priceQuote.groupBy({
    by: ["itemId", "source"],
    where: { recordedAt: { gte: new Date(Date.now() - days * DAY_MS) } },
    _avg: { unitPrice: true },
    _count: { _all: true },
  });
  const byItem = new Map();
  for (const r of rows) {
    const entry = byItem.get(r.itemId) ?? { market: null, sum: 0, n: 0 };
    const avg = Number(r._avg.unitPrice);
    if (r.source === "MARKET_FEED") entry.market = avg;
    entry.sum += avg * r._count._all;
    entry.n += r._count._all;
    byItem.set(r.itemId, entry);
  }
  return new Map([...byItem].map(([id, e]) => [id, e.market ?? e.sum / e.n]));
};

const latestBy = (quotes, keyFn) => {
  const latest = new Map();
  for (const q of quotes) {
    const key = keyFn(q);
    if (!latest.has(key) || latest.get(key).recordedAt < q.recordedAt) latest.set(key, q);
  }
  return latest;
};

const averageSince = (quotes, sinceMs) => {
  const values = quotes.filter((q) => q.recordedAt.getTime() >= sinceMs).map((q) => Number(q.unitPrice));
  return values.length ? mean(values) : null;
};

// Daily price trend for one item, split by source and vendor, with change and comparison stats.
const itemTrend = async (itemId, { days = 90 } = {}) => {
  const item = await prisma.item.findUnique({ where: { id: uuid(itemId, "itemId") } });
  if (!item) throw notFound("Item");
  const now = Date.now();
  const quotes = await prisma.priceQuote.findMany({
    where: { itemId, recordedAt: { gte: new Date(now - days * DAY_MS) } },
    include: { vendor: { select: { id: true, vendorName: true } } },
    orderBy: { recordedAt: "asc" },
  });

  const seriesMap = new Map();
  for (const q of quotes) {
    const key = q.source === "MARKET_FEED" ? `MARKET:${q.market ?? "market"}` : `${q.source}:${q.vendorId}`;
    const label = q.source === "MARKET_FEED" ? `Market (${q.market ?? "market"})` : `${q.vendor?.vendorName ?? "Unknown"} – ${q.source === "VENDOR_QUOTE" ? "quote" : "purchase"}`;
    if (!seriesMap.has(key)) seriesMap.set(key, { key, label, source: q.source, vendorId: q.vendorId, days: new Map() });
    const day = q.recordedAt.toISOString().slice(0, 10);
    const bucket = seriesMap.get(key).days.get(day) ?? [];
    bucket.push(Number(q.unitPrice));
    seriesMap.get(key).days.set(day, bucket);
  }
  const series = [...seriesMap.values()].map((s) => ({
    key: s.key,
    label: s.label,
    source: s.source,
    vendorId: s.vendorId,
    points: [...s.days].map(([day, values]) => ({ date: day, unitPrice: Math.round(mean(values) * 100) / 100 })),
  }));

  const market = quotes.filter((q) => q.source === "MARKET_FEED");
  const reference = market.length ? market : quotes;
  const latestMarket = market.length ? Number(market[market.length - 1].unitPrice) : null;
  const current = averageSince(reference, now - 7 * DAY_MS);
  const vendorPrices = [...latestBy(quotes.filter((q) => q.vendorId), (q) => q.vendorId).values()]
    .map((q) => ({ vendorId: q.vendorId, vendorName: q.vendor?.vendorName, unitPrice: Number(q.unitPrice), source: q.source, recordedAt: q.recordedAt }))
    .sort((a, b) => a.unitPrice - b.unitPrice);

  return {
    item: { id: item.id, sku: item.sku, itemName: item.itemName, unitOfMeasure: item.unitOfMeasure },
    ourAverageCost: Number(item.costPrice),
    latestMarketPrice: latestMarket,
    avg7d: current,
    avg30d: averageSince(reference, now - 30 * DAY_MS),
    change7dPct: pctChange(averageSince(reference.filter((q) => q.recordedAt.getTime() < now - 7 * DAY_MS), now - 14 * DAY_MS), current),
    change30dPct: pctChange(averageSince(reference.filter((q) => q.recordedAt.getTime() < now - 30 * DAY_MS), now - 60 * DAY_MS), current),
    costVsMarketPct: latestMarket ? pctChange(latestMarket, Number(item.costPrice)) : null,
    vendorPrices,
    bestVendor: vendorPrices[0] ?? null,
    series,
  };
};

// One row per item: our cost vs latest market rate vs best current vendor price.
const priceComparison = async ({ days = 30 } = {}) => {
  const [items, quotes] = await Promise.all([
    prisma.item.findMany({ where: { isActive: true }, select: { id: true, sku: true, itemName: true, category: true, unitOfMeasure: true, costPrice: true } }),
    prisma.priceQuote.findMany({
      where: { recordedAt: { gte: new Date(Date.now() - days * DAY_MS) } },
      include: { vendor: { select: { id: true, vendorName: true } } },
    }),
  ]);
  const latestMarket = latestBy(quotes.filter((q) => q.source === "MARKET_FEED"), (q) => q.itemId);
  const latestVendor = latestBy(quotes.filter((q) => q.vendorId), (q) => `${q.itemId}:${q.vendorId}`);
  const bestVendor = new Map();
  for (const q of latestVendor.values()) {
    const current = bestVendor.get(q.itemId);
    if (!current || Number(q.unitPrice) < Number(current.unitPrice)) bestVendor.set(q.itemId, q);
  }
  return items
    .map((item) => {
      const cost = Number(item.costPrice);
      const marketQ = latestMarket.get(item.id);
      const best = bestVendor.get(item.id);
      const marketPrice = marketQ ? Number(marketQ.unitPrice) : null;
      const bestPrice = best ? Number(best.unitPrice) : null;
      const cheapest = Math.min(...[marketPrice, bestPrice].filter((v) => v !== null));
      return {
        ...item,
        costPrice: cost,
        marketPrice,
        market: marketQ?.market ?? null,
        marketRecordedAt: marketQ?.recordedAt ?? null,
        bestVendorPrice: bestPrice,
        bestVendor: best ? { id: best.vendorId, vendorName: best.vendor?.vendorName } : null,
        costVsMarketPct: marketPrice ? pctChange(marketPrice, cost) : null,
        potentialSavingPct: Number.isFinite(cheapest) && cost > 0 ? Math.max(0, ((cost - cheapest) / cost) * 100) : null,
      };
    })
    .sort((a, b) => (b.potentialSavingPct ?? -1) - (a.potentialSavingPct ?? -1));
};

module.exports = {
  recordPrice,
  importMarketPrices,
  syncMarketFeed,
  startMarketFeedPolling,
  benchmarkPrices,
  itemTrend,
  priceComparison,
};
