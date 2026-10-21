const number = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && process.env[name] !== "" ? value : fallback;
};

module.exports = {
  port: number("PORT", 5100),
  jwtSecret: process.env.JWT_SECRET || "inventory-secret",
  authDisabled: process.env.AUTH_DISABLED === "true",
  planning: {
    // Days of consumption history used for usage, safety stock and XYZ analysis.
    historyDays: number("PLANNING_HISTORY_DAYS", 90),
    // Z-score for the target service level (1.65 ≈ 95%, 2.05 ≈ 98%).
    serviceLevelZ: number("SERVICE_LEVEL_Z", 1.65),
    // How often the store places orders; sizes the maximum stock level.
    reviewPeriodDays: number("REVIEW_PERIOD_DAYS", 7),
    // Used when an item has no vendor to take a lead time from.
    defaultLeadTimeDays: number("DEFAULT_LEAD_TIME_DAYS", 3),
  },
  marketFeed: {
    // Optional HTTP endpoint returning [{ sku, unitPrice, market?, recordedAt? }].
    url: process.env.MARKET_FEED_URL || "",
    apiKey: process.env.MARKET_FEED_API_KEY || "",
    intervalMinutes: number("MARKET_FEED_INTERVAL_MINUTES", 60),
  },
};
