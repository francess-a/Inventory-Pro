const crypto = require("crypto");
const prisma = require("../db");
const { badRequest, conflict, notFound, uuid, quantity, money, text, date, nonEmptyArray } = require("../lib/http");
const { DAY_MS } = require("../lib/planning");
const { receiveIntoCentral, inTransaction, D, round2, qty } = require("./ledger");

const PO_INCLUDE = {
  vendor: { select: { id: true, vendorName: true, leadTimeDays: true } },
  items: { include: { item: { select: { id: true, sku: true, itemName: true, unitOfMeasure: true } } } },
};

const docNumber = (prefix, now = new Date()) =>
  `${prefix}-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
const poNumber = (now) => docNumber("PO", now);

const dayOnly = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

// Shelf life in days: the item's own value, else its category default (null = not tracked).
const shelfLifeOf = (item) => item.shelfLifeDays ?? item.categoryRef?.defaultShelfLifeDays ?? null;

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
    quantityOrdered: quantity(line.quantityOrdered ?? line.quantity, `items[${i}].quantityOrdered`, { positive: true }),
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
 * Goods receipt (GRN) against a sent PO. Each line may be partially received and/or
 * rejected; accepted quantity enters central stock at the line's unit price (or the invoice
 * price given here) and updates weighted average cost. Every received or rejected line is
 * written to purchase_inward_ledger with its batch number, expiry date and supplier invoice;
 * accepted quantity becomes a stock batch.
 *
 * Body: { receivedAt?, invoiceNumber?, invoiceDate?, lines: [{ poItemId, quantityReceived,
 *         quantityRejected?, rejectionReason?, unitPrice?, batchNumber?, expiryDate?, manufactureDate? }] }
 * The PO row is locked first, so two receipts against the same order cannot both pass the
 * outstanding-quantity check.
 */
const receiveInTx = async (tx, id, body, receivedBy = "system") => {
  await tx.$queryRaw`SELECT id FROM purchase_order WHERE id = ${id}::uuid FOR UPDATE`;
  const po = await tx.purchaseOrder.findUnique({
    where: { id },
    include: { items: { include: { item: { include: { categoryRef: true } } } } },
  });
  if (!po) throw notFound("Purchase order");
  if (!["SENT", "PARTIALLY_RECEIVED"].includes(po.status)) {
    throw conflict(`Cannot receive against a ${po.status} order`);
  }
  const receivedAt = date(body.receivedAt, "receivedAt", { optional: true }) ?? new Date();
  const invoiceNumber = text(body.invoiceNumber, "invoiceNumber", { optional: true });
  const invoiceDate = date(body.invoiceDate, "invoiceDate", { optional: true });
  const grnNumber = docNumber("GRN", receivedAt);
  const lines = nonEmptyArray(body.lines, "lines");
  // Lock items in a fixed order so concurrent receipts and issues cannot deadlock.
  const ordered = lines
    .map((raw, i) => ({ raw, i, line: po.items.find((l) => l.id === raw?.poItemId) }))
    .sort((a, b) => (a.line?.itemId ?? "").localeCompare(b.line?.itemId ?? ""));

  for (const { raw, i } of ordered) {
    const lineId = uuid(raw.poItemId, `lines[${i}].poItemId`);
    const line = po.items.find((l) => l.id === lineId);
    if (!line) throw badRequest(`lines[${i}].poItemId does not belong to this order`);
    const accepted = quantity(raw.quantityReceived ?? 0, `lines[${i}].quantityReceived`);
    const rejected = quantity(raw.quantityRejected ?? 0, `lines[${i}].quantityRejected`);
    if (accepted + rejected === 0) continue;
    const outstanding = qty(Number(line.quantityOrdered) - Number(line.quantityReceived) - Number(line.quantityRejected));
    if (qty(accepted + rejected) > outstanding) {
      throw badRequest(`lines[${i}]: received + rejected (${qty(accepted + rejected)}) exceeds outstanding ${outstanding}`);
    }
    const unitPrice = money(raw.unitPrice, `lines[${i}].unitPrice`, { optional: true }) ?? D(line.unitPrice);
    const rejectionReason = text(raw.rejectionReason, `lines[${i}].rejectionReason`, { optional: true });
    if (rejected > 0 && !rejectionReason) throw badRequest(`lines[${i}].rejectionReason is required when rejecting`);
    const manufactureDate = date(raw.manufactureDate, `lines[${i}].manufactureDate`, { optional: true });
    const shelfLife = shelfLifeOf(line.item);
    const expiryDate =
      date(raw.expiryDate, `lines[${i}].expiryDate`, { optional: true }) ??
      (shelfLife ? new Date((manufactureDate ?? dayOnly(receivedAt)).getTime() + shelfLife * DAY_MS) : undefined);
    if (expiryDate && accepted > 0 && dayOnly(expiryDate) < dayOnly(receivedAt)) {
      throw badRequest(`lines[${i}]: ${line.item.itemName} expired on ${expiryDate.toISOString().slice(0, 10)}; reject it instead`);
    }
    if (expiryDate && manufactureDate && expiryDate < manufactureDate) {
      throw badRequest(`lines[${i}]: expiryDate is before manufactureDate`);
    }
    const inward = {
      grnNumber,
      purchaseOrderId: po.id,
      purchaseOrderItemId: line.id,
      batchNumber: text(raw.batchNumber, `lines[${i}].batchNumber`, { optional: true }) ?? `${grnNumber}-${i + 1}`,
      manufactureDate,
      expiryDate,
      quantityRejected: rejected,
      rejectionReason,
      unitOfMeasure: line.item.unitOfMeasure,
      invoiceNumber,
      invoiceDate,
      receivedBy,
    };

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

    if (accepted === 0) {
      // Whole line rejected: recorded on the inward ledger, no stock movement.
      await tx.purchaseInward.create({
        data: {
          ...inward,
          itemId: line.itemId,
          vendorId: po.vendorId,
          quantityReceived: 0,
          unitPrice,
          lineValue: 0,
          receivedAt,
        },
      });
    } else {
      await receiveIntoCentral(tx, {
        itemId: line.itemId,
        quantity: accepted,
        unitPrice,
        vendorId: po.vendorId,
        referenceId: po.id,
        timestamp: receivedAt,
        remarks: `${grnNumber} against ${po.poNumber}`,
        createdBy: receivedBy,
        inward,
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

  const complete = po.items.every(
    (l) => qty(Number(l.quantityReceived) + Number(l.quantityRejected)) >= Number(l.quantityOrdered)
  );
  return tx.purchaseOrder.update({
    where: { id },
    data: {
      status: complete ? "RECEIVED" : "PARTIALLY_RECEIVED",
      receivedAt: po.receivedAt ?? receivedAt,
      invoiceNumber: invoiceNumber ?? po.invoiceNumber,
    },
    include: PO_INCLUDE,
  });
};

const run = (fn) => inTransaction(prisma, fn);

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

const receivePurchaseOrder = async (id, body, receivedBy) =>
  withTotals(await run((tx) => receiveInTx(tx, uuid(id, "id"), body, receivedBy)));

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
 * Short-closes a partially received order: the undelivered balance is no longer expected,
 * so it stops counting as "on order" for replenishment. The shortfall stays on the lines
 * (ordered vs received), so supplier fill rates still reflect it.
 */
const closeInTx = async (tx, id, reason) => {
  const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { items: true } });
  if (!po) throw notFound("Purchase order");
  if (po.status !== "PARTIALLY_RECEIVED") throw conflict(`Only PARTIALLY_RECEIVED orders can be closed short (status is ${po.status})`);
  const short = po.items
    .map((l) => ({ l, missing: qty(Number(l.quantityOrdered) - Number(l.quantityReceived) - Number(l.quantityRejected)) }))
    .filter((x) => x.missing > 0);
  const note = `Closed short${reason ? ` (${reason})` : ""}: ${short.length} line${short.length === 1 ? "" : "s"} not delivered in full.`;
  return tx.purchaseOrder.update({
    where: { id },
    data: { status: "RECEIVED", notes: po.notes ? `${po.notes}\n${note}` : note },
    include: PO_INCLUDE,
  });
};

const closePurchaseOrder = async (id, reason) =>
  withTotals(await run((tx) => closeInTx(tx, uuid(id, "id"), text(reason, "reason", { optional: true }))));

/**
 * Direct purchase entry (cash / market purchase, or an invoice with no prior PO):
 * creates, sends and fully receives an order in one step.
 */
const createDirectPurchase = async (body, receivedBy) =>
  withTotals(
    await run(async (tx) => {
      const receivedAt = date(body.receivedAt, "receivedAt", { optional: true }) ?? new Date();
      const po = await createInTx(tx, { ...body, expectedDeliveryAt: receivedAt });
      await sendInTx(tx, po.id, receivedAt);
      const rawLines = body.items;
      return receiveInTx(
        tx,
        po.id,
        {
          receivedAt,
          invoiceNumber: body.invoiceNumber,
          invoiceDate: body.invoiceDate,
          lines: po.items.map((line, i) => {
            const rejected = Number(rawLines[i].quantityRejected ?? 0);
            return {
              poItemId: line.id,
              quantityReceived: qty(Number(line.quantityOrdered) - rejected),
              quantityRejected: rejected,
              rejectionReason: rawLines[i].rejectionReason,
              batchNumber: rawLines[i].batchNumber,
              expiryDate: rawLines[i].expiryDate,
              manufactureDate: rawLines[i].manufactureDate,
            };
          }),
        },
        receivedBy
      );
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
    const outstanding = Math.max(0, Number(l.quantityOrdered) - Number(l.quantityReceived) - Number(l.quantityRejected));
    onOrder.set(l.itemId, qty((onOrder.get(l.itemId) ?? 0) + outstanding));
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
  closePurchaseOrder,
  closeInTx,
  createDirectPurchase,
  openOrderQuantities,
  createInTx,
  sendInTx,
  receiveInTx,
};
