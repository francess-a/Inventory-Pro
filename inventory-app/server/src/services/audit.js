// Audit trail: the read-only stock ledger with hash-chain verification, the API audit log,
// and read access to the inward and issue ledgers and stock batches.
const prisma = require("../db");
const { badRequest, uuid, date } = require("../lib/http");
const { DAY_MS } = require("../lib/planning");
const { GENESIS, hashEntry } = require("./ledger");

const PAGE_MAX = 500;
const limitOf = (value, fallback = 100) => Math.min(PAGE_MAX, Math.max(1, Number(value) || fallback));
const range = (from, to) => {
  const gte = date(from, "from", { optional: true });
  const toDate = date(to, "to", { optional: true });
  return gte || toDate ? { ...(gte && { gte }), ...(toDate && { lt: new Date(toDate.getTime() + DAY_MS) }) } : undefined;
};

// ── Stock ledger ───────────────────────────────────────────────────────────

const listLedger = async ({ itemId, type, from, to, beforeSeq, limit } = {}) => {
  const rows = await prisma.inventoryTransaction.findMany({
    where: {
      ...(itemId && { itemId: uuid(itemId, "itemId") }),
      ...(type && { type }),
      ...(range(from, to) && { timestamp: range(from, to) }),
      ...(beforeSeq && { seq: { lt: BigInt(Number(beforeSeq)) } }),
    },
    include: { item: { select: { sku: true, itemName: true, unitOfMeasure: true } } },
    orderBy: { seq: "desc" },
    take: limitOf(limit),
  });
  return { rows, nextBeforeSeq: rows.length ? rows[rows.length - 1].seq : null };
};

/**
 * Re-computes every hash chain (or one item's) and reconciles the ledger with current stock:
 *  - each row's entry_hash must equal SHA-256 of (prev_hash ␟ canonical row);
 *  - each row's prev_hash must equal the previous row's entry_hash (GENESIS for the first);
 *  - the last row's closing quantity must equal central_stock.quantity_on_hand, and the sum of
 *    the item's batch quantities must equal it too.
 * Returns the chain heads, which can be exported and compared later to prove history was not rewritten.
 */
const verifyLedger = async ({ itemId } = {}) => {
  const where = itemId ? { itemId: uuid(itemId, "itemId") } : {};
  const [items, stocks, batches] = await Promise.all([
    prisma.item.findMany({ where: itemId ? { id: where.itemId } : {}, select: { id: true, sku: true, itemName: true } }),
    prisma.centralStock.findMany({ where }),
    prisma.stockBatch.groupBy({ by: ["itemId"], where, _sum: { quantityRemaining: true } }),
  ]);
  const onHand = new Map(stocks.map((s) => [s.itemId, Number(s.quantityOnHand)]));
  const batchQty = new Map(batches.map((b) => [b.itemId, Number(b._sum.quantityRemaining ?? 0)]));

  const problems = [];
  const heads = [];
  let entries = 0;
  for (const item of items) {
    let prev = GENESIS;
    let last = null;
    let cursor = 0n;
    for (;;) {
      const page = await prisma.inventoryTransaction.findMany({
        where: { itemId: item.id, seq: { gt: cursor } },
        orderBy: { seq: "asc" },
        take: 2000,
      });
      if (page.length === 0) break;
      for (const row of page) {
        entries += 1;
        if (row.prevHash !== prev) {
          problems.push({ itemId: item.id, sku: item.sku, seq: row.seq, problem: "BROKEN_LINK", detail: "prev_hash does not match the previous entry" });
        }
        if (hashEntry(row.prevHash, row) !== row.entryHash) {
          problems.push({ itemId: item.id, sku: item.sku, seq: row.seq, problem: "TAMPERED", detail: "row content does not match its entry_hash" });
        }
        prev = row.entryHash;
        last = row;
      }
      cursor = page[page.length - 1].seq;
    }
    const stock = onHand.get(item.id) ?? 0;
    if (last && Math.abs(Number(last.closingStockCentral) - stock) > 0.0005) {
      problems.push({
        itemId: item.id,
        sku: item.sku,
        seq: last.seq,
        problem: "STOCK_MISMATCH",
        detail: `ledger closing ${Number(last.closingStockCentral)} vs central stock ${stock}`,
      });
    }
    if (Math.abs((batchQty.get(item.id) ?? 0) - stock) > 0.0005) {
      problems.push({
        itemId: item.id,
        sku: item.sku,
        seq: last?.seq ?? null,
        problem: "BATCH_MISMATCH",
        detail: `batches ${batchQty.get(item.id) ?? 0} vs central stock ${stock}`,
      });
    }
    if (last) heads.push({ itemId: item.id, sku: item.sku, seq: last.seq, entryHash: last.entryHash });
  }
  return { verifiedAt: new Date(), items: items.length, entries, valid: problems.length === 0, problems, heads };
};

// ── API audit log ──────────────────────────────────────────────────────────

const SECRET_KEYS = /pass(word)?|token|secret|authorization/i;
const redact = (value, depth = 0) => {
  if (value === null || typeof value !== "object" || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1)]));
};

const UUID_IN_PATH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Express middleware: after every POST/PUT/PATCH/DELETE under /api finishes, appends a row to
 * audit_log with who, what, the outcome and the (redacted) request body. Writing the audit
 * row never fails the request; a write error is logged.
 */
const auditTrail = (req, res, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  res.on("finish", () => {
    const body = req.body && typeof req.body === "object" && Object.keys(req.body).length ? redact(req.body) : null;
    prisma.auditLog
      .create({
        data: {
          actorId: req.user?.id ?? null,
          actorName: req.user?.name ?? req.user?.email ?? null,
          actorRole: req.user?.role ?? null,
          method: req.method,
          path: req.originalUrl.split("?")[0].slice(0, 500),
          statusCode: res.statusCode,
          entityId: req.originalUrl.match(UUID_IN_PATH)?.[0] ?? null,
          requestBody: body ?? undefined,
          ipAddress: req.ip ?? null,
        },
      })
      .catch((err) => console.error("audit log write failed:", err.message));
  });
  return next();
};

const listAuditLog = async ({ from, to, actorId, path, entityId, beforeId, limit } = {}) => {
  const rows = await prisma.auditLog.findMany({
    where: {
      ...(range(from, to) && { occurredAt: range(from, to) }),
      ...(actorId && { actorId: String(actorId) }),
      ...(entityId && { entityId: String(entityId) }),
      ...(path && { path: { contains: String(path) } }),
      ...(beforeId && { id: { lt: BigInt(Number(beforeId)) } }),
    },
    orderBy: { id: "desc" },
    take: limitOf(limit),
  });
  return { rows, nextBeforeId: rows.length ? rows[rows.length - 1].id : null };
};

// ── Inward / issue ledgers and batches ─────────────────────────────────────

const listInward = ({ from, to, itemId, vendorId, purchaseOrderId, grnNumber, invoiceNumber, limit } = {}) =>
  prisma.purchaseInward.findMany({
    where: {
      ...(range(from, to) && { receivedAt: range(from, to) }),
      ...(itemId && { itemId: uuid(itemId, "itemId") }),
      ...(vendorId && { vendorId: uuid(vendorId, "vendorId") }),
      ...(purchaseOrderId && { purchaseOrderId: uuid(purchaseOrderId, "purchaseOrderId") }),
      ...(grnNumber && { grnNumber: String(grnNumber) }),
      ...(invoiceNumber && { invoiceNumber: { contains: String(invoiceNumber), mode: "insensitive" } }),
    },
    include: {
      item: { select: { sku: true, itemName: true } },
      vendor: { select: { vendorName: true } },
      purchaseOrder: { select: { poNumber: true } },
    },
    orderBy: [{ receivedAt: "desc" }, { grnNumber: "asc" }],
    take: limitOf(limit, 200),
  });

const listIssues = ({ from, to, itemId, outletDepartmentId, requisitionId, limit } = {}) =>
  prisma.issueLedger.findMany({
    where: {
      ...(range(from, to) && { issuedAt: range(from, to) }),
      ...(itemId && { itemId: uuid(itemId, "itemId") }),
      ...(outletDepartmentId && { outletDepartmentId: uuid(outletDepartmentId, "outletDepartmentId") }),
      ...(requisitionId && { requisitionId: uuid(requisitionId, "requisitionId") }),
    },
    include: {
      item: { select: { sku: true, itemName: true, unitOfMeasure: true } },
      outlet: { select: { code: true, name: true } },
      requisition: { select: { requisitionNumber: true } },
    },
    orderBy: [{ issuedAt: "desc" }, { issueNumber: "asc" }],
    take: limitOf(limit, 200),
  });

// Batches still in stock, earliest expiry first; `expiringWithinDays` narrows to those expiring soon (or expired).
const listBatches = ({ itemId, expiringWithinDays } = {}) => {
  const days = expiringWithinDays === undefined || expiringWithinDays === "" ? null : Number(expiringWithinDays);
  if (days !== null && !(days >= 0)) throw badRequest("expiringWithinDays must be a non-negative number");
  return prisma.stockBatch.findMany({
    where: {
      quantityRemaining: { gt: 0 },
      ...(itemId && { itemId: uuid(itemId, "itemId") }),
      ...(days !== null && { expiryDate: { lte: new Date(Date.now() + days * DAY_MS) } }),
    },
    include: { item: { select: { sku: true, itemName: true, unitOfMeasure: true } } },
    orderBy: [{ expiryDate: { sort: "asc", nulls: "last" } }, { receivedAt: "asc" }],
    take: PAGE_MAX,
  });
};

module.exports = { listLedger, verifyLedger, auditTrail, listAuditLog, listInward, listIssues, listBatches, redact };
