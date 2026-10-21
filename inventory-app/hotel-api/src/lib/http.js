const { Prisma } = require("@prisma/client");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const badRequest = (message) => new HttpError(400, message);
const notFound = (what) => new HttpError(404, `${what} not found`);
const conflict = (message) => new HttpError(409, message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uuid = (value, name) => {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw badRequest(`${name} must be a UUID`);
  return value;
};

const int = (value, name, { min = 0, optional = false } = {}) => {
  if (value === undefined || value === null || value === "") {
    if (optional) return undefined;
    throw badRequest(`${name} is required`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw badRequest(`${name} must be an integer >= ${min}`);
  return n;
};

const money = (value, name, { optional = false } = {}) => {
  if (value === undefined || value === null || value === "") {
    if (optional) return undefined;
    throw badRequest(`${name} is required`);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw badRequest(`${name} must be a non-negative number`);
  return new Prisma.Decimal(n).toDecimalPlaces(2);
};

const text = (value, name, { optional = false } = {}) => {
  if (value === undefined || value === null || String(value).trim() === "") {
    if (optional) return undefined;
    throw badRequest(`${name} is required`);
  }
  return String(value).trim();
};

const oneOf = (value, name, allowed, { optional = false } = {}) => {
  if (value === undefined || value === null || value === "") {
    if (optional) return undefined;
    throw badRequest(`${name} is required`);
  }
  if (!allowed.includes(value)) throw badRequest(`${name} must be one of ${allowed.join(", ")}`);
  return value;
};

const date = (value, name, { optional = false } = {}) => {
  if (value === undefined || value === null || value === "") {
    if (optional) return undefined;
    throw badRequest(`${name} is required`);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw badRequest(`${name} must be a valid date`);
  return d;
};

const nonEmptyArray = (value, name) => {
  if (!Array.isArray(value) || value.length === 0) throw badRequest(`${name} must be a non-empty array`);
  return value;
};

// Express error handler: maps HttpError and common Prisma errors to JSON responses.
const errorHandler = (err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ message: err.message });
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      return res.status(409).json({ message: `Duplicate value for ${err.meta?.target ?? "unique field"}` });
    }
    if (err.code === "P2025") return res.status(404).json({ message: "Record not found" });
    if (err.code === "P2003") return res.status(400).json({ message: "Referenced record does not exist" });
  }
  if (err.type === "entity.parse.failed") return res.status(400).json({ message: "Invalid JSON body" });
  console.error(err);
  return res.status(500).json({ message: "Internal server error" });
};

module.exports = {
  HttpError,
  badRequest,
  notFound,
  conflict,
  uuid,
  int,
  money,
  text,
  oneOf,
  date,
  nonEmptyArray,
  errorHandler,
};
