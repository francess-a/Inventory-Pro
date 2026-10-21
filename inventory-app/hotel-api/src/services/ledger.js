// Every change to central stock goes through these helpers so that quantity,
// weighted average cost, stock value and the transaction log stay consistent.
// All functions expect to run inside a Prisma interactive transaction (`tx`).

const { Prisma } = require("@prisma/client");
const { conflict, notFound } = require("../lib/http");

const D = (value) => new Prisma.Decimal(value);
const round2 = (value) => D(value).toDecimalPlaces(2);
// Quantities are Decimal(12, 3) in the database and plain numbers here, rounded to 3 places.
const qty = (value) => Math.round(Number(value) * 1000) / 1000;

// Locks the item's central stock row for the rest of the transaction.
const lockCentral = async (tx, itemId) => {
  const item = await tx.item.findUnique({ where: { id: itemId }, select: { id: true, costPrice: true } });
  if (!item) throw notFound(`Item ${itemId}`);
  let rows = await tx.$queryRaw`
    SELECT "quantityOnHand" FROM "CentralStock" WHERE "itemId" = ${itemId}::uuid FOR UPDATE`;
  if (rows.length === 0) {
    await tx.centralStock.create({ data: { itemId } });
    rows = await tx.$queryRaw`
      SELECT "quantityOnHand" FROM "CentralStock" WHERE "itemId" = ${itemId}::uuid FOR UPDATE`;
  }
  return { onHand: qty(rows[0].quantityOnHand), costPrice: D(item.costPrice) };
};

const writeCentral = (tx, itemId, quantityOnHand, costPrice) =>
  tx.centralStock.update({
    where: { itemId },
    data: { quantityOnHand, totalValue: round2(D(quantityOnHand).mul(costPrice)) },
  });

const log = (tx, data) => tx.inventoryTransaction.create({ data });

/**
 * Goods receipt into the central store. Updates the weighted average cost:
 *   newCost = (onHand × oldCost + qty × price) / (onHand + qty)
 */
const receiveIntoCentral = async (tx, { itemId, quantity, unitPrice, vendorId, referenceId, timestamp, remarks }) => {
  const { onHand, costPrice } = await lockCentral(tx, itemId);
  const price = D(unitPrice);
  const closing = qty(onHand + quantity);
  const newCost =
    onHand <= 0 ? price : round2(D(onHand).mul(costPrice).add(D(quantity).mul(price)).div(closing));

  await tx.item.update({ where: { id: itemId }, data: { costPrice: newCost } });
  const central = await writeCentral(tx, itemId, closing, newCost);
  await log(tx, {
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
    timestamp,
  });
  return { closingStock: closing, costPrice: newCost };
};

// Removes stock from the central store at the current weighted average cost.
const issueFromCentral = async (tx, { itemId, quantity, type, destination, referenceId, remarks, timestamp }) => {
  const { onHand, costPrice } = await lockCentral(tx, itemId);
  if (quantity > onHand) {
    throw conflict(`Insufficient central stock for item ${itemId}: requested ${quantity}, on hand ${onHand}`);
  }
  const closing = qty(onHand - quantity);
  const central = await writeCentral(tx, itemId, closing, costPrice);
  const value = round2(costPrice.mul(quantity));
  await log(tx, {
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
    timestamp,
  });
  return { unitCost: costPrice, value, closingStock: closing };
};

// Stock-count correction. Positive adds stock, negative removes it (at current cost).
const adjustCentral = async (tx, { itemId, quantityChange, remarks }) => {
  const { onHand, costPrice } = await lockCentral(tx, itemId);
  const closing = qty(onHand + quantityChange);
  if (closing < 0) throw conflict(`Adjustment would make central stock negative (on hand ${onHand})`);
  const central = await writeCentral(tx, itemId, closing, costPrice);
  await log(tx, {
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
  });
  return { closingStock: closing };
};

// Waste written off from an outlet. Central stock is untouched but still recorded
// on the log line so every row carries the central closing balance.
const wasteFromOutlet = async (tx, { itemId, outletDepartmentId, quantity, remarks }) => {
  const { onHand, costPrice } = await lockCentral(tx, itemId);
  const updated = await tx.outletStock.updateMany({
    where: { outletDepartmentId, itemId, quantityOnHand: { gte: quantity } },
    data: { quantityOnHand: { decrement: quantity } },
  });
  if (updated.count === 0) throw conflict("Insufficient outlet stock to write off");
  const central = await tx.centralStock.findUnique({ where: { itemId } });
  const value = round2(costPrice.mul(quantity));
  await log(tx, {
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
  });
  return { unitCost: costPrice, value, closingStock: onHand };
};

module.exports = { receiveIntoCentral, issueFromCentral, adjustCentral, wasteFromOutlet, D, round2, qty };
