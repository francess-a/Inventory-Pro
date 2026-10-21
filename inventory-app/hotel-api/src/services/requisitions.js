const crypto = require("crypto");
const prisma = require("../db");
const { badRequest, conflict, notFound, uuid, int, text, date, nonEmptyArray } = require("../lib/http");
const { issueFromCentral, D, round2 } = require("./ledger");

const REQ_INCLUDE = {
  department: true,
  items: { include: { item: { select: { id: true, sku: true, itemName: true, unitOfMeasure: true, costPrice: true } } } },
};

const requisitionNumber = (now = new Date()) =>
  `REQ-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

const withTotals = (req) => {
  let estimatedValue = D(0);
  let issuedValue = D(0);
  for (const line of req.items) {
    estimatedValue = estimatedValue.add(D(line.item.costPrice).mul(line.quantityRequested));
    issuedValue = issuedValue.add(D(line.issuedValue));
  }
  return { ...req, estimatedValue: round2(estimatedValue), issuedValue: round2(issuedValue) };
};

const findOrThrow = async (tx, id) => {
  const req = await tx.requisition.findUnique({ where: { id: uuid(id, "id") }, include: { items: true } });
  if (!req) throw notFound("Requisition");
  return req;
};

const listRequisitions = async ({ status, outletDepartmentId } = {}) => {
  const rows = await prisma.requisition.findMany({
    where: { ...(status && { status }), ...(outletDepartmentId && { outletDepartmentId }) },
    include: REQ_INCLUDE,
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows.map(withTotals);
};

const getRequisition = async (id) => {
  const req = await prisma.requisition.findUnique({ where: { id: uuid(id, "id") }, include: REQ_INCLUDE });
  if (!req) throw notFound("Requisition");
  return withTotals(req);
};

const createRequisition = async (body, requestedByDefault) => {
  const outletDepartmentId = uuid(body.outletDepartmentId, "outletDepartmentId");
  const items = nonEmptyArray(body.items, "items").map((line, i) => ({
    itemId: uuid(line.itemId, `items[${i}].itemId`),
    quantityRequested: int(line.quantityRequested ?? line.quantity, `items[${i}].quantityRequested`, { min: 1 }),
  }));
  const department = await prisma.outletDepartment.findUnique({ where: { id: outletDepartmentId } });
  if (!department) throw notFound("Outlet department");
  const req = await prisma.requisition.create({
    data: {
      requisitionNumber: requisitionNumber(),
      outletDepartmentId,
      requestedBy: text(body.requestedBy, "requestedBy", { optional: true }) ?? requestedByDefault,
      remarks: text(body.remarks, "remarks", { optional: true }),
      items: { create: items },
    },
    include: REQ_INCLUDE,
  });
  return withTotals(req);
};

const decide = (status) => async (id, by, remarks) =>
  prisma.$transaction(async (tx) => {
    const req = await findOrThrow(tx, id);
    if (req.status !== "PENDING") throw conflict(`Only PENDING requisitions can be ${status.toLowerCase()}`);
    const updated = await tx.requisition.update({
      where: { id: req.id },
      data: { status, approvedBy: by, approvedAt: new Date(), ...(remarks && { remarks }) },
      include: REQ_INCLUDE,
    });
    return withTotals(updated);
  });

const approveRequisition = decide("APPROVED");
const rejectRequisition = decide("REJECTED");

/**
 * Issues an approved requisition from the central store to the outlet.
 * `lines` is optional: omitted lines are issued in full. Each issue is valued at the
 * item's weighted average cost and moves stock CENTRAL -> outlet.
 */
const issueInTx = async (tx, id, body, issuedBy, at = new Date()) => {
  const req = await findOrThrow(tx, id);
  if (req.status !== "APPROVED") throw conflict(`Only APPROVED requisitions can be issued (status is ${req.status})`);
  const overrides = new Map();
  for (const [i, raw] of (body.lines ?? []).entries()) {
    const lineId = uuid(raw.requisitionItemId, `lines[${i}].requisitionItemId`);
    overrides.set(lineId, int(raw.quantityIssued, `lines[${i}].quantityIssued`));
  }
  for (const lineId of overrides.keys()) {
    if (!req.items.some((l) => l.id === lineId)) throw badRequest(`Line ${lineId} does not belong to this requisition`);
  }

  for (const line of req.items) {
    const quantity = overrides.get(line.id) ?? line.quantityRequested;
    if (quantity > line.quantityRequested) {
      throw badRequest(`Cannot issue ${quantity}; only ${line.quantityRequested} requested for line ${line.id}`);
    }
    if (quantity === 0) continue;
    const { unitCost, value } = await issueFromCentral(tx, {
      itemId: line.itemId,
      quantity,
      type: "OUTLET_ISSUE",
      destination: req.outletDepartmentId,
      referenceId: req.id,
      remarks: `Issue ${req.requisitionNumber}`,
      timestamp: at,
    });
    await tx.outletStock.upsert({
      where: { outletDepartmentId_itemId: { outletDepartmentId: req.outletDepartmentId, itemId: line.itemId } },
      create: { outletDepartmentId: req.outletDepartmentId, itemId: line.itemId, quantityOnHand: quantity },
      update: { quantityOnHand: { increment: quantity } },
    });
    await tx.requisitionItem.update({
      where: { id: line.id },
      data: { quantityIssued: quantity, unitCost, issuedValue: value },
    });
  }

  const updated = await tx.requisition.update({
    where: { id: req.id },
    data: { status: "ISSUED", issuedBy, issuedAt: at },
    include: REQ_INCLUDE,
  });
  return withTotals(updated);
};

const issueRequisition = (id, body, issuedBy) =>
  prisma.$transaction((tx) => issueInTx(tx, id, body, issuedBy), { timeout: 20000 });

// Issued quantity and value per department (and per item within it) for a period.
const departmentConsumption = async ({ from, to } = {}) => {
  const fromDate = date(from, "from", { optional: true }) ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const toDate = date(to, "to", { optional: true }) ?? new Date();
  const lines = await prisma.requisitionItem.findMany({
    where: { quantityIssued: { gt: 0 }, requisition: { issuedAt: { gte: fromDate, lte: toDate } } },
    include: {
      item: { select: { id: true, itemName: true, category: true, unitOfMeasure: true } },
      requisition: { select: { department: true } },
    },
  });
  const byDept = new Map();
  for (const line of lines) {
    const dept = line.requisition.department;
    if (!byDept.has(dept.id)) byDept.set(dept.id, { department: dept, totalValue: D(0), items: new Map() });
    const entry = byDept.get(dept.id);
    entry.totalValue = entry.totalValue.add(line.issuedValue);
    const item = entry.items.get(line.itemId) ?? { ...line.item, quantity: 0, value: D(0) };
    item.quantity += line.quantityIssued;
    item.value = item.value.add(line.issuedValue);
    entry.items.set(line.itemId, item);
  }
  return {
    from: fromDate,
    to: toDate,
    departments: [...byDept.values()]
      .map((e) => ({
        department: e.department,
        totalValue: round2(e.totalValue),
        items: [...e.items.values()].sort((a, b) => b.value.comparedTo(a.value)),
      }))
      .sort((a, b) => b.totalValue.comparedTo(a.totalValue)),
  };
};

module.exports = {
  listRequisitions,
  getRequisition,
  createRequisition,
  approveRequisition,
  rejectRequisition,
  issueRequisition,
  issueInTx,
  departmentConsumption,
};
