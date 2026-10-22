const number = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && process.env[name] !== "" ? value : fallback;
};

module.exports = {
  port: number("PORT", 5100),
  jwtSecret: process.env.JWT_SECRET || "inventory-secret",
  authDisabled: process.env.AUTH_DISABLED === "true",
  // Currency used in generated report text (the web app formats its own figures).
  currency: process.env.CURRENCY || "INR",
  // Anyone may create a store-staff account unless this is "false" (admins can always add users).
  allowSignup: process.env.ALLOW_SIGNUP !== "false",
  // Built React app served by this server; set to "" to run the API only.
  frontendDir: process.env.FRONTEND_DIR ?? require("path").join(__dirname, "..", "..", "frontend", "build"),
  planning: {
    // Days of consumption history used for usage, safety stock and XYZ analysis.
    historyDays: number("PLANNING_HISTORY_DAYS", 90),
    // Z-score for the target service level (1.65 ≈ 95%, 2.05 ≈ 98%).
    serviceLevelZ: number("SERVICE_LEVEL_Z", 1.65),
    // How often the store places orders; sizes the maximum stock level.
    reviewPeriodDays: number("REVIEW_PERIOD_DAYS", 7),
    // Used when an item has no vendor to take a lead time from.
    defaultLeadTimeDays: number("DEFAULT_LEAD_TIME_DAYS", 3),
    // Days of history the demand forecast looks at (a year enables month-of-year seasonality).
    forecastHistoryDays: number("FORECAST_HISTORY_DAYS", 364),
    // Holt smoothing constants: level (alpha), trend (beta) and trend damping (phi).
    smoothing: {
      alpha: number("FORECAST_ALPHA", 0.3),
      beta: number("FORECAST_BETA", 0.1),
      phi: number("FORECAST_PHI", 0.9),
    },
    // Non-perishables whose purchase price rose by at least this share over the last 30 days
    // (vs the 30 before) get `forwardBuyDays` of extra cover, within shelf life.
    priceRiseThreshold: number("PRICE_RISE_THRESHOLD", 0.05),
    forwardBuyDays: number("FORWARD_BUY_DAYS", 7),
  },
  valuation: {
    // Days without issues after which stock counts as slow-moving capital.
    slowMovingDays: number("SLOW_MOVING_DAYS", 60),
    // How often the server checks for missing end-of-day valuation snapshots (0 = off).
    snapshotIntervalMinutes: number("VALUATION_SNAPSHOT_INTERVAL_MINUTES", 60),
  },
  marketFeed: {
    // Optional HTTP endpoint returning [{ sku, unitPrice, market?, recordedAt? }].
    url: process.env.MARKET_FEED_URL || "",
    apiKey: process.env.MARKET_FEED_API_KEY || "",
    intervalMinutes: number("MARKET_FEED_INTERVAL_MINUTES", 60),
  },
};
