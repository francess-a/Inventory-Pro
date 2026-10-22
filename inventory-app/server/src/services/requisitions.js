const crypto = require("crypto");
const prisma = require("../db");
const { badRequest, conflict, notFound, uuid, quantity: parseQuantity, text, date, nonEmptyArray } = require("../lib/http");
const { issueFromCentral, inTransaction, D, round2, qty } = require("./ledger");

const REQ_INCLUDE = {
  department: true,
  items: { include: { item: { select: { id: true, sku: true, itemName: true, unitOfMeasure: true, costPrice: true } } } },
};

const docNumber = (prefix, now = new Date()) =>
  `${prefix}-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
const requisitionNumber = (now) => docNumber("REQ", now);

const withTotals = (req) => {
  let estimatedValue = D(0);
  let issuedValue = D(0);
  for (const line of req.items) {
    estimatedValue = estimatedValue.add(D(line.item.costPrice).mul(line.quantityRequested));
    issuedValue = issuedValue.add(D(line.issuedValue));
  }
  return { ...req, estimatedValue: round2(estimatedValue), issuedValue: round2(issuedValue) };
};

// Locks the requisition row (SELECT … FOR UPDATE) so concurrent approve / reject / issue
// requests on the same requisition run one at a time and each sees the other's status change.
const findOrThrow = async (tx, id) => {
  const reqId = uuid(id, "id");
  await tx.$queryRaw`SELECT id FROM requisition WHERE id = ${reqId}::uuid FOR UPDATE`;
  const req = await tx.requisition.findUnique({ where: { id: reqId }, include: { items: true } });
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
    quantityRequested: parseQuantity(line.quantityRequested ?? line.quantity, `items[${i}].quantityRequested`, { positive: true }),
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
 *
 * Double-deduction protection, in order:
 *  1. the requisition row is locked and must be APPROVED (a second request waits, then sees ISSUED);
 *  2. item stock rows are locked in item-id order (no deadlocks between concurrent issues);
 *  3. issue_requisition_ledger.requisition_item_id is unique, so the database itself refuses
 *     a second issue of the same line;
 *  4. with an idempotency key, a retried request returns the original result instead of 409.
 */
const issueInTx = async (tx, id, body, issuedBy, at = new Date(), idempotencyKey) => {
  const req = await findOrThrow(tx, id);
  if (idempotencyKey && req.status === "ISSUED" && req.issueIdempotencyKey === idempotencyKey) {
    const original = await tx.requisition.findUnique({ where: { id: req.id }, include: REQ_INCLUDE });
    return { ...withTotals(original), replayed: true };
  }
  if (req.status !== "APPROVED") throw conflict(`Only APPROVED requisitions can be issued (status is ${req.status})`);
  const issueNumber = docNumber("ISS", at);
  const overrides = new Map();
  for (const [i, raw] of (body.lines ?? []).entries()) {
    const lineId = uuid(raw.requisitionItemId, `lines[${i}].requisitionItemId`);
    overrides.set(lineId, parseQuantity(raw.quantityIssued, `lines[${i}].quantityIssued`));
  }
  for (const lineId of overrides.keys()) {
    if (!req.items.some((l) => l.id === lineId)) throw badRequest(`Line ${lineId} does not belong to this requisition`);
  }

  const lines = [...req.items].sort((a, b) => a.itemId.localeCompare(b.itemId) || a.id.localeCompare(b.id));
  for (const line of lines) {
    const requested = qty(line.quantityRequested);
    const quantity = overrides.get(line.id) ?? requested;
    if (quantity > requested) {
      throw badRequest(`Cannot issue ${quantity}; only ${line.quantityRequested} requested for line ${line.id}`);
    }
    if (quantity === 0) continue;
    const { unitCost, value, transactionId, allocations } = await issueFromCentral(tx, {
      itemId: line.itemId,
      quantity,
      type: "OUTLET_ISSUE",
      destination: req.outletDepartmentId,
      referenceId: req.id,
      remarks: `${issueNumber} for ${req.requisitionNumber}`,
      timestamp: at,
      createdBy: issuedBy,
    });
    await tx.issueLedger.create({
      data: {
        issueNumber,
        requisitionId: req.id,
        requisitionItemId: line.id,
        itemId: line.itemId,
        outletDepartmentId: req.outletDepartmentId,
        quantityRequested: requested,
        quantityIssued: quantity,
        unitCost,
        issueValue: value,
        batchAllocations: allocations,
        issuedBy,
        issuedAt: at,
        transactionId,
      },
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
    data: { status: "ISSUED", issuedBy, issuedAt: at, ...(idempotencyKey && { issueIdempotencyKey: idempotencyKey }) },
    include: REQ_INCLUDE,
  });
  return withTotals(updated);
};

const issueRequisition = (id, body, issuedBy, idempotencyKey) =>
  inTransaction(prisma, (tx) => issueInTx(tx, id, body, issuedBy, new Date(), idempotencyKey));

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
    item.quantity = qty(item.quantity + Number(line.quantityIssued));
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

/**
 * Indent vs received: what departments asked for (indented) against what the store issued to
 * them, over requisitions raised in the period. Each line ends up in one state:
 *   FULL     issued in full            SHORT    issued, but less than requested
 *   REJECTED requisition rejected      WAITING  still pending approval or issue
 * Values use the issue cost where the line was issued, otherwise the item's current average cost.
 */
const INDENT_STATES = ["FULL", "SHORT", "REJECTED", "WAITING"];
const DAY_MS = 24 * 60 * 60 * 1000;
const r2 = (n) => Math.round(n * 100) / 100;
const pct = (part, whole) => (whole > 0 ? r2((part / whole) * 100) : null);

const weekOf = (d) => {
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
};

const departmentLabel = (d) =>
  d.name ?? (d.subDepartment === "NONE" ? d.mainOutlet.replace(/_/g, " ") : `${d.mainOutlet} / ${d.subDepartment.replace(/_/g, " ")}`);

const indentVsReceived = async (query = {}) => {
  const toDate = date(query.to, "to", { optional: true }) ?? new Date();
  const fromDate = date(query.from, "from", { optional: true }) ?? new Date(toDate.getTime() - 30 * DAY_MS);
  if (fromDate >= toDate) throw badRequest("from must be before to");
  const where = {
    createdAt: { gte: fromDate, lte: toDate },
    ...(query.outletDepartmentId && { outletDepartmentId: uuid(query.outletDepartmentId, "outletDepartmentId") }),
    ...(query.status && { status: query.status }),
  };
  const reqs = await prisma.requisition.findMany({
    where,
    include: {
      department: true,
      items: { include: { item: { select: { id: true, itemName: true, category: true, unitOfMeasure: true, costPrice: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });

  const lines = [];
  for (const req of reqs) {
    for (const line of req.items) {
      const requested = qty(line.quantityRequested);
      const received = req.status === "ISSUED" ? qty(line.quantityIssued) : 0;
      const unitCost = Number(line.unitCost ?? line.item.costPrice);
      const state =
        req.status === "REJECTED" ? "REJECTED" : req.status !== "ISSUED" ? "WAITING" : received >= requested ? "FULL" : "SHORT";
      const shortQty = state === "SHORT" || state === "REJECTED" ? qty(requested - received) : 0;
      lines.push({
        requisitionId: req.id,
        requisitionNumber: req.requisitionNumber,
        createdAt: req.createdAt,
        issuedAt: req.issuedAt,
        status: req.status,
        departmentId: req.outletDepartmentId,
        department: departmentLabel(req.department),
        requestedBy: req.requestedBy,
        itemId: line.itemId,
        item: line.item.itemName,
        category: line.item.category.replace(/_/g, " "),
        unit: line.item.unitOfMeasure,
        requested,
        received,
        shortQty,
        unitCost: r2(unitCost),
        indentValue: r2(requested * unitCost),
        receivedValue: r2(Number(line.issuedValue)),
        shortValue: r2(shortQty * unitCost),
        state,
      });
    }
  }

  // Totals for a group of lines. Fill rate counts only closed lines (issued or rejected), so
  // requisitions still waiting don't drag it down.
  const summarise = (rows) => {
    const closed = rows.filter((l) => l.state !== "WAITING");
    const reqIds = new Set(rows.map((l) => l.requisitionId));
    const issuedReqs = new Map();
    for (const l of rows) if (l.status === "ISSUED" && l.issuedAt) issuedReqs.set(l.requisitionId, l.issuedAt - l.createdAt);
    const sum = (list, key) => r2(list.reduce((s, l) => s + l[key], 0));
    const closedIndent = sum(closed, "indentValue");
    return {
      requisitions: reqIds.size,
      lines: rows.length,
      indentValue: sum(rows, "indentValue"),
      receivedValue: sum(rows, "receivedValue"),
      shortValue: sum(rows.filter((l) => l.state === "SHORT"), "shortValue"),
      rejectedValue: sum(rows.filter((l) => l.state === "REJECTED"), "indentValue"),
      waitingValue: sum(rows.filter((l) => l.state === "WAITING"), "indentValue"),
      fillRateValue: pct(sum(closed, "receivedValue"), closedIndent),
      linesInFullPct: pct(closed.filter((l) => l.state === "FULL").length, closed.length),
      avgTurnaroundHours: issuedReqs.size ? r2([...issuedReqs.values()].reduce((s, ms) => s + ms, 0) / issuedReqs.size / 3600000) : null,
      states: Object.fromEntries(INDENT_STATES.map((st) => [st, rows.filter((l) => l.state === st).length])),
    };
  };

  const groupBy = (keyFn) => {
    const map = new Map();
    for (const l of lines) {
      const key = keyFn(l);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(l);
    }
    return map;
  };

  const byDepartment = [...groupBy((l) => l.departmentId)]
    .map(([id, rows]) => ({ id, name: rows[0].department, ...summarise(rows) }))
    .sort((a, b) => b.indentValue - a.indentValue);

  const byItem = [...groupBy((l) => l.itemId)]
    .map(([id, rows]) => {
      const sum = (key) => r2(rows.reduce((s, l) => s + l[key], 0));
      const closed = rows.filter((l) => l.state !== "WAITING");
      return {
        id,
        name: rows[0].item,
        category: rows[0].category,
        unit: rows[0].unit,
        requested: qty(rows.reduce((s, l) => s + l.requested, 0)),
        received: qty(rows.reduce((s, l) => s + l.received, 0)),
        shortQty: qty(rows.reduce((s, l) => s + l.shortQty, 0)),
        waitingQty: qty(rows.filter((l) => l.state === "WAITING").reduce((s, l) => s + l.requested, 0)),
        indentValue: sum("indentValue"),
        receivedValue: sum("receivedValue"),
        shortValue: r2(rows.filter((l) => l.state !== "WAITING").reduce((s, l) => s + l.shortValue, 0)),
        fillRateValue: pct(closed.reduce((s, l) => s + l.receivedValue, 0), closed.reduce((s, l) => s + l.indentValue, 0)),
      };
    })
    .sort((a, b) => b.shortValue - a.shortValue || b.indentValue - a.indentValue);

  const weekly = [...groupBy((l) => weekOf(l.createdAt))]
    .map(([week, rows]) => {
      const start = new Date(`${week}T00:00:00Z`);
      return {
        week,
        partial: start < fromDate || start.getTime() + 7 * DAY_MS > toDate.getTime(),
        indentValue: r2(rows.reduce((s, l) => s + l.indentValue, 0)),
        receivedValue: r2(rows.reduce((s, l) => s + l.receivedValue, 0)),
      };
    })
    .sort((a, b) => a.week.localeCompare(b.week));

  return {
    from: fromDate,
    to: toDate,
    summary: summarise(lines),
    byDepartment,
    byItem,
    weekly,
    lines: lines.slice(0, 1000),
    totalLines: lines.length,
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
  indentVsReceived,
};
