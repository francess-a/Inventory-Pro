const CURRENCY = process.env.REACT_APP_CURRENCY || "INR";

const currencyFormat = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: CURRENCY,
  maximumFractionDigits: 2,
});

export const money = (value) =>
  value === null || value === undefined || value === "" ? "–" : currencyFormat.format(Number(value));

export const num = (value, digits = 1) =>
  value === null || value === undefined ? "–" : Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });

export const pct = (value, digits = 1) =>
  value === null || value === undefined ? "–" : `${Number(value).toFixed(digits)}%`;

export const ratioPct = (value) => (value === null || value === undefined ? "–" : `${(value * 100).toFixed(1)}%`);

export const qty = (value) => Math.round(Number(value) * 1000) / 1000;

export const date = (value) => (value ? new Date(value).toLocaleDateString() : "–");

export const departmentName = (dept) =>
  !dept
    ? "–"
    : dept.name ??
      (dept.subDepartment === "NONE" ? dept.mainOutlet.replace(/_/g, " ") : `${dept.mainOutlet} / ${dept.subDepartment.replace(/_/g, " ")}`);

export const label = (value) => (value ? value.replace(/_/g, " ").toLowerCase() : "");
