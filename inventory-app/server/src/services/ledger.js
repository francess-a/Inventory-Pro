// Every change to central stock goes through these helpers so that quantity, weighted
// average cost, stock value, stock batches and the transaction ledger stay consistent.
// All functions expect to run inside a Prisma interactive transaction (`tx`).
//
// Concurrency: lockCentral() takes a row lock (SELECT … FOR UPDATE) on the item's
// central_stock row before anything is read or written, so two requests that move the same
// item run one after the other. That lock also serialises the item's hash chain.
//
// Ledger integrity: stock_transaction_ledger rows are append-only (database triggers) and
// chained per item: entry_hash = SHA-256(prev_hash ␟ canonical row). (item_id, prev_hash)
// is unique, so two writers can never attach to the same predecessor.

const crypto = require("crypto");
const { Prisma } = require("@prisma/client");
const { conflict, notFound, HttpError } = require("../lib/http");

const D = (value) => new Prisma.Decimal(value);
const round2 = (value) => D(value).toDecimalPlaces(2);
// Quantities are Decimal(12, 3) in the database and plain numbers here, rounded to 3 places.
const qty = (value) => Math.round(Number(value) * 1000) / 1000;

const GENESIS = "GENESIS";
const SEP = String.fromCharCode(31); // unit separator: never appears in normal text

// Fixed-scale decimal text identical to PostgreSQL's numeric(p, s)::text.
const fixed = (value, places) => {
  const s = D(value).toFixed(places);
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
};

// The exact string hashed for a ledger row. The migration that sealed the pre-existing rows
// builds the same string in SQL, so keep the two in step.
const canonical = (prevHash, row) =>
  [
    prevHash,
    row.id,
    row.itemId,
    row.type,
    row.sourceLocation,
    row.destinationLocation,
    fixed(row.quantity, 3),
    fixed(row.unitCost, 2),
    fixed(row.transactionValue, 2),
    fixed(row.closingStockCentral, 3),
    fixed(row.closingStockCentralValue, 2),
    row.referenceId ?? "",
    row.remarks ?? "",
    row.createdBy ?? "",
    new Date(row.timestamp).toISOString(),
  ].join(SEP);

const hashEntry = (prevHash, row) => crypto.createHash("sha256").update(canonical(prevHash, row), "utf8").digest("hex");

// Locks the item's central stock row for the rest of the transaction.
const lockCentral = async (tx, itemId) => {
  const item = await tx.item.findUnique({ where: { id: itemId }, select: { id: true, costPrice: true } });
  if (!item) throw notFound(`Item ${itemId}`);
  let rows = await tx.$queryRaw`
    SELECT quantity_on_hand FROM central_stock WHERE item_id = ${itemId}::uuid FOR UPDATE`;
  if (rows.length === 0) {
    await tx.centralStock.upsert({ where: { itemId }, create: { itemId }, update: {} });
    rows = await tx.$queryRaw`
      SELECT quantity_on_hand FROM central_stock WHERE item_id = ${itemId}::uuid FOR UPDATE`;
  }
  return { onHand: qty(rows[0].quantity_on_hand), costPrice: D(item.costPrice) };
};

const writeCentral = (tx, itemId, quantityOnHand, costPrice) =>
  tx.centralStock.update({
    where: { itemId },
    data: { quantityOnHand, totalValue: round2(D(quantityOnHand).mul(costPrice)) },
  });

// Appends one hash-chained row to stock_transaction_ledger. Callers hold the item lock.
const appendEntry = async (tx, data) => {
  const last = await tx.inventoryTransaction.findFirst({
    where: { itemId: data.itemId },
    orderBy: { seq: "desc" },
    select: { entryHash: true },
  });
  const prevHash = last?.entryHash ?? GENESIS;
  const row = {
    id: crypto.randomUUID(),
    referenceId: null,
    remarks: null,
    createdBy: null,
    ...data,
    timestamp: data.timestamp ?? new Date(),
  };
  return tx.inventoryTransaction.create({ data: { ...row, prevHash, entryHash: hashEntry(prevHash, row) } });
};

// Takes `quantity` out of the item's batches, earliest expiry first, then oldest receipt.
const consumeBatches = async (tx, itemId, quantity) => {
  const batches = await tx.$queryRaw`
    SELECT id, batch_number, expiry_date, quantity_remaining FROM stock_batch
    WHERE item_id = ${itemId}::uuid AND quantity_remaining > 0
    ORDER BY expiry_date ASC NULLS LAST, received_at ASC, id ASC
    FOR UPDATE`;
  let left = quantity;
  const allocations = [];
  for (const b of batches) {
    if (left <= 0) break;
    const take = qty(Math.min(left, Number(b.quantity_remaining)));
    await tx.stockBatch.update({ where: { id: b.id }, data: { quantityRemaining: { decrement: take } } });
    allocations.push({
      batchId: b.id,
      batchNumber: b.batch_number,
      expiryDate: b.expiry_date ? b.expiry_date.toISOString().slice(0, 10) : null,
      quantity: take,
    });
    left = qty(left - take);
  }
  if (left > 0) throw new HttpError(500, `Batch records for item ${itemId} are short by ${left}; run a stock count adjustment`);
  return allocations;
};

/**
 * Goods receipt into the central store. Updates the weighted average cost
 *   newCost = (onHand × oldCost + qty × price) / (onHand + qty)
 * and, when `inward` is given, writes the purchase_inward_ledger row and its stock batch.
 */
const receiveIntoCentral = async (
  tx,
  { itemId, quantity, unitPrice, vendorId, referenceId, timestamp, remarks, createdBy, inward }
) => {
  const { onHand, costPrice } = await lockCentral(tx, itemId);
  const price = D(unitPrice);
  const closing = qty(onHand + quantity);
  const newCost =
    onHand <= 0 ? round2(price) : round2(D(onHand).mul(costPrice).add(D(quantity).mul(price)).div(closing));

  await tx.item.update({ where: { id: itemId }, data: { costPrice: newCost } });
  const central = await writeCentral(tx, itemId, closing, newCost);
  const at = timestamp ?? new Date();
  const entry = await appendEntry(tx, {
    itemId,
    type: "PURCHASE_RECEIPT",
    sourceLocation: `VENDOR:${vendorId}`,
    destinationLocation: "CENTRAL",
    quantity,
    unitCost: round2(price),
    transactionValue: round2(price.mul(quantity)),
    closingStockCentral: closing,
    closingStockCentralValue: central.totalValue,
    referenceId,
    remarks,
    createdBy,
    timestamp: at,
  });

  let inwardRow = null;
  if (inward) {
    inwardRow = await tx.purchaseInward.create({
      data: {
        ...inward,
        itemId,
        vendorId,
        quantityReceived: quantity,
        unitPrice: round2(price),
        lineValue: round2(price.mul(quantity)),
        receivedAt: at,
        transactionId: entry.id,
      },
    });
  }
  await tx.stockBatch.create({
    data: {
      itemId,
      inwardId: inwardRow?.id,
      source: inwardRow ? "PURCHASE" : "OPENING",
      batchNumber: inwardRow?.batchNumber ?? `RCPT-${entry.seq}`,
      expiryDate: inwardRow?.expiryDate ?? null,
      receivedAt: at,
      unitCost: round2(price),
      quantityReceived: quantity,
      quantityRemaining: quantity,
    },
  });
  return { closingStock: closing, costPrice: newCost, transactionId: entry.id, inward: inwardRow };
};

// Removes stock from the central store at the current weighted average cost.
const issueFromCentral = async (
  tx,
  { itemId, quantity, type, destination, referenceId, remarks, timestamp, createdBy }
) => {
  const { onHand, costPrice } = await lockCentral(tx, itemId);
  if (quantity > onHand) {
    throw conflict(`Insufficient central stock for item ${itemId}: requested ${quantity}, on hand ${onHand}`);
  }
  const closing = qty(onHand - quantity);
  const allocations = await consumeBatches(tx, itemId, quantity);
  const central = await writeCentral(tx, itemId, closing, costPrice);
  const value = round2(costPrice.mul(quantity));
  const entry = await appendEntry(tx, {
    itemId,
    type,
    sourceLocation: "CENTRAL",
    destinationLocation: destination,
    quantity,
    unitCost: costPrice,
    transactionValue: value,
    closingStockCentral: closing,
    closingStockCentralValue: central.totalValue,
    referenceId,
    remarks,
    createdBy,
    timestamp,
  });
  return { unitCost: costPrice, value, closingStock: closing, transactionId: entry.id, allocations };
};

// Stock-count correction. Positive adds stock (as a new batch), negative removes it (at current cost).
const adjustCentral = async (tx, { itemId, quantityChange, remarks, createdBy }) => {
  const { onHand, costPrice } = await lockCentral(tx, itemId);
  const closing = qty(onHand + quantityChange);
  if (closing < 0) throw conflict(`Adjustment would make central stock negative (on hand ${onHand})`);
  if (quantityChange < 0) await consumeBatches(tx, itemId, -quantityChange);
  const central = await writeCentral(tx, itemId, closing, costPrice);
  const entry = await appendEntry(tx, {
    itemId,
    type: "ADJUSTMENT",
    sourceLocation: quantityChange >= 0 ? "ADJUSTMENT" : "CENTRAL",
    destinationLocation: quantityChange >= 0 ? "CENTRAL" : "ADJUSTMENT",
    quantity: quantityChange,
    unitCost: costPrice,
    transactionValue: round2(costPrice.mul(quantityChange)),
    closingStockCentral: closing,
    closingStockCentralValue: central.totalValue,
    remarks,
    createdBy,
  });
  if (quantityChange > 0) {
    await tx.stockBatch.create({
      data: {
        itemId,
        source: "ADJUSTMENT",
        batchNumber: `ADJ-${entry.seq}`,
        receivedAt: entry.timestamp,
        unitCost: costPrice,
        quantityReceived: quantityChange,
        quantityRemaining: quantityChange,
      },
    });
  }
  return { closingStock: closing, transactionId: entry.id };
};

// Waste written off from an outlet. Central stock is untouched but still recorded
// on the ledger row so every row carries the central closing balance.
const wasteFromOutlet = async (tx, { itemId, outletDepartmentId, quantity, remarks, createdBy }) => {
  const { onHand, costPrice } = await lockCentral(tx, itemId);
  const updated = await tx.outletStock.updateMany({
    where: { outletDepartmentId, itemId, quantityOnHand: { gte: quantity } },
    data: { quantityOnHand: { decrement: quantity } },
  });
  if (updated.count === 0) throw conflict("Insufficient outlet stock to write off");
  const central = await tx.centralStock.findUnique({ where: { itemId } });
  const value = round2(costPrice.mul(quantity));
  const entry = await appendEntry(tx, {
    itemId,
    type: "WASTE",
    sourceLocation: outletDepartmentId,
    destinationLocation: "WASTE_BIN",
    quantity,
    unitCost: costPrice,
    transactionValue: value,
    closingStockCentral: onHand,
    closingStockCentralValue: central.totalValue,
    remarks,
    createdBy,
  });
  return { unitCost: costPrice, value, closingStock: onHand, transactionId: entry.id };
};

/**
 * Runs `fn` in a transaction and retries (up to 3 attempts) when PostgreSQL aborts it for a
 * deadlock or serialisation failure. Item locks are taken in a fixed order by callers, so
 * this is a safety net rather than the normal path.
 */
const RETRYABLE = /40P01|40001|deadlock detected|could not serialize/;
const inTransaction = async (prisma, fn, { attempts = 3, timeout = 20000 } = {}) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await prisma.$transaction(fn, { timeout });
    } catch (err) {
      const retryable = err.code === "P2034" || RETRYABLE.test(`${err.meta?.code ?? ""} ${err.message ?? ""}`);
      if (!retryable || attempt >= attempts) throw err;
    }
  }
};

module.exports = {
  GENESIS,
  canonical,
  hashEntry,
  appendEntry,
  receiveIntoCentral,
  issueFromCentral,
  adjustCentral,
  wasteFromOutlet,
  inTransaction,
  D,
  round2,
  qty,
};
