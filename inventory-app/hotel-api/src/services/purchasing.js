const crypto = require("crypto");
const prisma = require("../db");
const { badRequest, conflict, notFound, uuid, int, money, text, date, nonEmptyArray } = require("../lib/http");
const { DAY_MS } = require("../lib/planning");
const { receiveIntoCentral, D, round2 } = require("./ledger");

const PO_INCLUDE = {
  vendor: { select: { id: true, vendorName: true, leadTimeDays: true } },
  items: { include: { item: { select: { id: true, sku: true, itemName: true, unitOfMeasure: true } } } },
};

const poNumber = (now = new Date()) =>
  `PO-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

const withTotals = (po) => {
  let orderedValue = D(0);
  let receivedValue = D(0);
  for (const line of po.items) {
    orderedValue = orderedValue.add(D(line.unitPrice).mul(line.quantityOrdered));
    receivedValue = receivedValue.add(D(line.unitPrice).mul(line.quantityReceived));
  }
  return { ...po, orderedValue: round2(orderedValue), receivedValue: round2(receivedValue) };
};

const parseLines = (lines) =>
  nonEmptyArray(lines, "items").map((line, i) => ({
    itemId: uuid(line.itemId, `items[${i}].itemId`),
    quantityOrdered: int(line.quantityOrdered ?? line.quantity, `items[${i}].quantityOrdered`, { min: 1 }),
    unitPrice: money(line.unitPrice, `items[${i}].unitPrice`),
  }));

const createInTx = async (tx, body) => {
  const vendorId = uuid(body.vendorId, "vendorId");
  const lines = parseLines(body.items);
  const vendor = await tx.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor) throw notFound("Vendor");
  if (!vendor.isActive) throw badRequest("Vendor is inactive");
  return tx.purchaseOrder.create({
    data: {
      poNumber: poNumber(),
      vendorId,
      notes: text(body.notes, "notes", { optional: true }),
      expectedDeliveryAt: date(body.expectedDeliveryAt, "expectedDeliveryAt", { optional: true }),
      items: { create: lines },
    },
    include: PO_INCLUDE,
  });
};

const sendInTx = async (tx, id, sentAt = new Date()) => {
  const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { vendor: true } });
  if (!po) throw notFound("Purchase order");
  if (po.status !== "DRAFT") throw conflict(`Only DRAFT orders can be sent (status is ${po.status})`);
  return tx.purchaseOrder.update({
    where: { id },
    data: {
      status: "SENT",
      sentAt,
      expectedDeliveryAt: po.expectedDeliveryAt ?? new Date(sentAt.getTime() + po.vendor.leadTimeDays * DAY_MS),
    },
    include: PO_INCLUDE,
  });
};

/**
 * Goods receipt against a sent PO. Each line may be partially received and/or rejected;
 * accepted quantity enters central stock at the line's unit price (or the invoice price
 * given here) and updates weighted average cost.
 */
const receiveInTx = async (tx, id, body) => {
  const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { items: true } });
  if (!po) throw notFound("Purchase order");
  if (!["SENT", "PARTIALLY_RECEIVED"].includes(po.status)) {
    throw conflict(`Cannot receive against a ${po.status} order`);
  }
  const receivedAt = date(body.receivedAt, "receivedAt", { optional: true }) ?? new Date();
  const lines = nonEmptyArray(body.lines, "lines");

  for (const [i, raw] of lines.entries()) {
    const lineId = uuid(raw.poItemId, `lines[${i}].poItemId`);
    const line = po.items.find((l) => l.id === lineId);
    if (!line) throw badRequest(`lines[${i}].poItemId does not belong to this order`);
    const accepted = int(raw.quantityReceived ?? 0, `lines[${i}].quantityReceived`);
    const rejected = int(raw.quantityRejected ?? 0, `lines[${i}].quantityRejected`);
    if (accepted + rejected === 0) continue;
    const outstanding = line.quantityOrdered - line.quantityReceived - line.quantityRejected;
    if (accepted + rejected > outstanding) {
      throw badRequest(`lines[${i}]: received + rejected (${accepted + rejected}) exceeds outstanding ${outstanding}`);
    }
    const unitPrice = money(raw.unitPrice, `lines[${i}].unitPrice`, { optional: true }) ?? D(line.unitPrice);
    const rejectionReason = text(raw.rejectionReason, `lines[${i}].rejectionReason`, { optional: true });
    if (rejected > 0 && !rejectionReason) throw badRequest(`lines[${i}].rejectionReason is required when rejecting`);

    const updated = await tx.purchaseOrderItem.update({
      where: { id: line.id },
      data: {
        quantityReceived: { increment: accepted },
        quantityRejected: { increment: rejected },
        unitPrice,
        ...(rejectionReason && { rejectionReason }),
      },
    });
    Object.assign(line, updated);

    if (accepted > 0) {
      await receiveIntoCentral(tx, {
        itemId: line.itemId,
        quantity: accepted,
        unitPrice,
        vendorId: po.vendorId,
        referenceId: po.id,
        timestamp: receivedAt,
        remarks: `GRN ${po.poNumber}`,
      });
      await tx.priceQuote.create({
        data: {
          itemId: line.itemId,
          vendorId: po.vendorId,
          source: "PURCHASE_RECEIPT",
          unitPrice,
          recordedAt: receivedAt,
        },
      });
    }
  }

  const complete = po.items.every((l) => l.quantityReceived + l.quantityRejected >= l.quantityOrdered);
  return tx.purchaseOrder.update({
    where: { id },
    data: {
      status: complete ? "RECEIVED" : "PARTIALLY_RECEIVED",
      receivedAt: po.receivedAt ?? receivedAt,
      invoiceNumber: text(body.invoiceNumber, "invoiceNumber", { optional: true }) ?? po.invoiceNumber,
    },
    include: PO_INCLUDE,
  });
};

const run = (fn) => prisma.$transaction(fn, { timeout: 20000 });

const listPurchaseOrders = async ({ status, vendorId } = {}) => {
  const orders = await prisma.purchaseOrder.findMany({
    where: { ...(status && { status }), ...(vendorId && { vendorId }) },
    include: PO_INCLUDE,
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return orders.map(withTotals);
};

const getPurchaseOrder = async (id) => {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: uuid(id, "id") }, include: PO_INCLUDE });
  if (!po) throw notFound("Purchase order");
  return withTotals(po);
};

const createPurchaseOrder = async (body) => withTotals(await run((tx) => createInTx(tx, body)));

const sendPurchaseOrder = async (id) => withTotals(await run((tx) => sendInTx(tx, uuid(id, "id"))));

const receivePurchaseOrder = async (id, body) =>
  withTotals(await run((tx) => receiveInTx(tx, uuid(id, "id"), body)));

const cancelPurchaseOrder = async (id) =>
  run(async (tx) => {
    const po = await tx.purchaseOrder.findUnique({ where: { id: uuid(id, "id") } });
    if (!po) throw notFound("Purchase order");
    if (!["DRAFT", "SENT"].includes(po.status)) throw conflict(`Cannot cancel a ${po.status} order`);
    return withTotals(
      await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: "CANCELLED" }, include: PO_INCLUDE })
    );
  });

/**
 * Direct purchase entry (cash / market purchase, or an invoice with no prior PO):
 * creates, sends and fully receives an order in one step.
 */
const createDirectPurchase = async (body) =>
  withTotals(
    await run(async (tx) => {
      const receivedAt = date(body.receivedAt, "receivedAt", { optional: true }) ?? new Date();
      const po = await createInTx(tx, { ...body, expectedDeliveryAt: receivedAt });
      await sendInTx(tx, po.id, receivedAt);
      const rawLines = body.items;
      return receiveInTx(tx, po.id, {
        receivedAt,
        invoiceNumber: body.invoiceNumber,
        lines: po.items.map((line, i) => {
          const rejected = Number(rawLines[i].quantityRejected ?? 0);
          return {
            poItemId: line.id,
            quantityReceived: line.quantityOrdered - rejected,
            quantityRejected: rejected,
            rejectionReason: rawLines[i].rejectionReason,
          };
        }),
      });
    })
  );

// Quantity ordered but not yet received or rejected, per item, across open orders.
const openOrderQuantities = async () => {
  const lines = await prisma.purchaseOrderItem.findMany({
    where: { purchaseOrder: { status: { in: ["SENT", "PARTIALLY_RECEIVED"] } } },
    select: { itemId: true, quantityOrdered: true, quantityReceived: true, quantityRejected: true },
  });
  const onOrder = new Map();
  for (const l of lines) {
    const outstanding = Math.max(0, l.quantityOrdered - l.quantityReceived - l.quantityRejected);
    onOrder.set(l.itemId, (onOrder.get(l.itemId) ?? 0) + outstanding);
  }
  return onOrder;
};

module.exports = {
  listPurchaseOrders,
  getPurchaseOrder,
  createPurchaseOrder,
  sendPurchaseOrder,
  receivePurchaseOrder,
  cancelPurchaseOrder,
  createDirectPurchase,
  openOrderQuantities,
  createInTx,
  sendInTx,
  receiveInTx,
};
