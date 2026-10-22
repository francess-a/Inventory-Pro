// Demand forecasting for the central store. Pure functions (no database access).
//
// Demand is forecast from weekly totals of central-store issues, because day-to-day kitchen
// demand is too noisy to model directly while a week captures the hotel's weekly cycle.
// Three candidate models are back-tested on the most recent weeks and the one with the
// lowest absolute error is used:
//
//   SMA   simple mean of the whole history (the previous planning method; the baseline)
//   WMA   weighted moving average of the last 4 weeks, weights 4-3-2-1 (newest heaviest)
//   HOLT  Holt's double exponential smoothing with a damped trend
//           level_t = α·y_t + (1 − α)(level_{t−1} + φ·trend_{t−1})
//           trend_t = β(level_t − level_{t−1}) + (1 − β)·φ·trend_{t−1}
//           ŷ_{t+h} = level_t + (φ + φ² + … + φ^h)·trend_t
//
// The chosen weekly forecast is then multiplied by a month-of-year seasonal index when at
// least a year of history exists:
//   index(m) = average daily demand in calendar month m ÷ average daily demand over the year
// clamped to 0.5–2.0, averaged over the days of the forecast horizon.

const { DAY_MS, mean, weeklyTotals } = require("./planning");

const DEFAULTS = { alpha: 0.3, beta: 0.1, phi: 0.9, holdoutWeeks: 4, minWeeksForModels: 8 };

const sma = (weeks) => mean(weeks);

const wma = (weeks, span = 4) => {
  const recent = weeks.slice(-span);
  if (recent.length === 0) return 0;
  let weighted = 0;
  let weights = 0;
  recent.forEach((value, i) => {
    weighted += value * (i + 1);
    weights += i + 1;
  });
  return weighted / weights;
};

// Fits Holt's damped-trend model and returns level, trend and an h-step forecaster.
const holt = (weeks, { alpha = DEFAULTS.alpha, beta = DEFAULTS.beta, phi = DEFAULTS.phi } = {}) => {
  if (weeks.length === 0) return { level: 0, trend: 0, forecast: () => 0 };
  let level = weeks[0];
  let trend = weeks.length > 1 ? weeks[1] - weeks[0] : 0;
  for (let t = 1; t < weeks.length; t += 1) {
    const previous = level;
    level = alpha * weeks[t] + (1 - alpha) * (previous + phi * trend);
    trend = beta * (level - previous) + (1 - beta) * phi * trend;
  }
  const forecast = (h) => {
    let damp = 0;
    for (let i = 1; i <= h; i += 1) damp += phi ** i;
    return Math.max(0, level + damp * trend);
  };
  return { level, trend, forecast };
};

const MODELS = {
  SMA: (weeks) => sma(weeks),
  WMA: (weeks) => wma(weeks),
  HOLT: (weeks, opts) => holt(weeks, opts).forecast(1),
};

// One-step-ahead back-test over the last `holdout` weeks. Returns total absolute error per model.
const backtest = (weeks, opts = {}) => {
  const holdout = opts.holdoutWeeks ?? DEFAULTS.holdoutWeeks;
  const errors = Object.fromEntries(Object.keys(MODELS).map((m) => [m, 0]));
  let actualTotal = 0;
  for (let k = holdout; k >= 1; k -= 1) {
    const train = weeks.slice(0, weeks.length - k);
    const actual = weeks[weeks.length - k];
    actualTotal += actual;
    for (const [name, model] of Object.entries(MODELS)) errors[name] += Math.abs(model(train, opts) - actual);
  }
  return { errors, actualTotal };
};

/**
 * Month-of-year seasonal index for the days [start, start + horizonDays). Needs a daily
 * series of at least 365 days ending at `endDate`; otherwise 1 (no seasonal adjustment).
 */
const seasonalIndex = (daily, endDate, horizonDays) => {
  if (daily.length < 365) return 1;
  const year = daily.slice(-365);
  const overall = mean(year);
  if (overall <= 0) return 1;
  const firstDay = endDate.getTime() - 365 * DAY_MS;
  const sums = new Array(12).fill(0);
  const counts = new Array(12).fill(0);
  year.forEach((value, i) => {
    const month = new Date(firstDay + (i + 0.5) * DAY_MS).getUTCMonth();
    sums[month] += value;
    counts[month] += 1;
  });
  let total = 0;
  for (let d = 0; d < horizonDays; d += 1) {
    const month = new Date(endDate.getTime() + (d + 0.5) * DAY_MS).getUTCMonth();
    const index = counts[month] ? sums[month] / counts[month] / overall : 1;
    total += Math.min(2, Math.max(0.5, index));
  }
  return horizonDays > 0 ? total / horizonDays : 1;
};

/**
 * Forecasts average daily demand over the next `horizonDays` (lead time + review period).
 *
 * @param daily       daily demand, oldest first, ending at `endDate`
 * @returns { method, dailyRate, horizonDemand, seasonalIndex, trendPerWeek, wmape, errors }
 *   wmape = Σ|error| ÷ Σ actual over the back-test weeks (null when not enough history).
 */
const forecastDemand = ({ daily, endDate = new Date(), horizonDays = 7, options = {} }) => {
  const opts = { ...DEFAULTS, ...options };
  const weeks = weeklyTotals(daily);
  const horizonWeeks = Math.max(1, Math.ceil(horizonDays / 7));
  const season = seasonalIndex(daily, endDate, horizonDays);

  if (weeks.length < opts.minWeeksForModels || mean(weeks) === 0) {
    const dailyRate = mean(daily) * season;
    return {
      method: "SMA",
      dailyRate,
      horizonDemand: dailyRate * horizonDays,
      seasonalIndex: season,
      trendPerWeek: 0,
      wmape: null,
      errors: null,
    };
  }

  const { errors, actualTotal } = backtest(weeks, opts);
  const method = Object.entries(errors).sort((a, b) => a[1] - b[1])[0][0];
  const fit = holt(weeks, opts);
  let weekly;
  if (method === "HOLT") {
    let sum = 0;
    for (let h = 1; h <= horizonWeeks; h += 1) sum += fit.forecast(h);
    weekly = sum / horizonWeeks;
  } else {
    weekly = MODELS[method](weeks, opts);
  }
  const dailyRate = Math.max(0, (weekly / 7) * season);
  return {
    method,
    dailyRate,
    horizonDemand: dailyRate * horizonDays,
    seasonalIndex: season,
    trendPerWeek: method === "HOLT" ? fit.trend : 0,
    wmape: actualTotal > 0 ? errors[method] / actualTotal : null,
    errors,
  };
};

module.exports = { DEFAULTS, sma, wma, holt, backtest, seasonalIndex, forecastDemand };
