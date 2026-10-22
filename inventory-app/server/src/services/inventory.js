// Item master, item categories, outlets and direct stock operations (adjustments, waste).
const prisma = require("../db");
const { MainOutlet, SubDepartment, OutletType } = require("@prisma/client");
const { badRequest, notFound, uuid, int, quantity, money, text, oneOf } = require("../lib/http");
const { adjustCentral, issueFromCentral, wasteFromOutlet, inTransaction } = require("./ledger");

const MAIN_OUTLETS = Object.values(MainOutlet);
const SUB_DEPARTMENTS = Object.values(SubDepartment);
const OUTLET_TYPES = Object.values(OutletType);

// ── Item categories (multi-tier: group > category > sub-category) ──────────

// Flat list with each node's parent code, full path ("Food › Meat & poultry › Chicken") and item count.
const listCategories = async () => {
  const [nodes, counts] = await Promise.all([
    prisma.itemCategory.findMany({ orderBy: [{ level: "asc" }, { sortOrder: "asc" }, { name: "asc" }] }),
    prisma.item.groupBy({ by: ["category"], _count: { _all: true } }),
  ]);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const count = new Map(counts.map((c) => [c.category, c._count._all]));
  const path = (n) => (n.parentId ? [...path(byId.get(n.parentId)), n.name] : [n.name]);
  const rows = nodes.map((n) => ({
    code: n.code,
    name: n.name,
    level: n.level,
    parentCode: n.parentId ? byId.get(n.parentId).code : null,
    path: path(n).join(" › "),
    isPerishable: n.isPerishable,
    defaultShelfLifeDays: n.defaultShelfLifeDays,
    sortOrder: n.sortOrder,
    itemCount: count.get(n.code) ?? 0,
  }));
  // Depth-first order so a tree reads top to bottom.
  const children = (code) => rows.filter((r) => r.parentCode === code);
  const ordered = [];
  const walk = (r) => {
    ordered.push(r);
    children(r.code).forEach(walk);
  };
  children(null).forEach(walk);
  return ordered;
};

// Codes of a category and everything below it.
const categoryWithDescendants = async (code) => {
  const nodes = await prisma.itemCategory.findMany({ select: { id: true, code: true, parentId: true } });
  const root = nodes.find((n) => n.code === code);
  if (!root) return [code];
  const result = [];
  const walk = (id) => {
    const node = nodes.find((n) => n.id === id);
    result.push(node.code);
    nodes.filter((n) => n.parentId === id).forEach((n) => walk(n.id));
  };
  walk(root.id);
  return result;
};

const CODE_RE = /^[A-Z][A-Z0-9_]{1,39}$/;

const createCategory = async (body) => {
  const code = text(body.code, "code").toUpperCase();
  if (!CODE_RE.test(code)) throw badRequest("code must be 2-40 characters: A-Z, 0-9 and _");
  const parentCode = text(body.parentCode, "parentCode", { optional: true });
  const parent = parentCode ? await prisma.itemCategory.findUnique({ where: { code: parentCode } }) : null;
  if (parentCode && !parent) throw badRequest(`parentCode ${parentCode} does not exist`);
  if (parent && parent.level >= 3) throw badRequest("Categories go at most three levels deep");
  return prisma.itemCategory.create({
    data: {
      code,
      name: text(body.name, "name"),
      parentId: parent?.id ?? null,
      level: parent ? parent.level + 1 : 1,
      isPerishable: typeof body.isPerishable === "boolean" ? body.isPerishable : parent?.isPerishable ?? false,
      defaultShelfLifeDays: int(body.defaultShelfLifeDays, "defaultShelfLifeDays", { min: 1, optional: true }) ?? parent?.defaultShelfLifeDays ?? null,
      sortOrder: int(body.sortOrder, "sortOrder", { optional: true }) ?? 0,
    },
  });
};

const updateCategory = async (code, body) => {
  const data = {
    name: text(body.name, "name", { optional: true }),
    ...(typeof body.isPerishable === "boolean" && { isPerishable: body.isPerishable }),
    ...(body.defaultShelfLifeDays !== undefined && {
      defaultShelfLifeDays: body.defaultShelfLifeDays === null ? null : int(body.defaultShelfLifeDays, "defaultShelfLifeDays", { min: 1 }),
    }),
    sortOrder: int(body.sortOrder, "sortOrder", { optional: true }),
  };
  return prisma.itemCategory.update({
    where: { code: text(code, "code") },
    data: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)),
  });
};

// Items belong to a category or sub-category (level 2 or 3), never directly to a top-level group.
const assertItemCategory = async (code) => {
  if (code === undefined) return;
  const node = await prisma.itemCategory.findUnique({ where: { code } });
  if (!node) throw badRequest(`category ${code} does not exist`);
  if (node.level < 2) throw badRequest(`category ${code} is a group; choose one of its categories`);
};

// ── Items ──────────────────────────────────────────────────────────────────

const parseItem = (body, { partial = false } = {}) => {
  const opt = { optional: partial };
  const data = {
    sku: text(body.sku, "sku", opt),
    barcode: text(body.barcode, "barcode", opt),
    itemName: text(body.itemName, "itemName", opt),
    category: text(body.category, "category", opt),
    costPrice: money(body.costPrice, "costPrice", { optional: true }),
    unitOfMeasure: text(body.unitOfMeasure, "unitOfMeasure", opt),
    minStockLevel: quantity(body.minStockLevel, "minStockLevel", { optional: true }),
    maxStockLevel: quantity(body.maxStockLevel, "maxStockLevel", { optional: true }),
    reorderPoint: quantity(body.reorderPoint, "reorderPoint", { optional: true }),
    orderMultiple: quantity(body.orderMultiple, "orderMultiple", { positive: true, optional: true }),
    ...(body.shelfLifeDays !== undefined && {
      shelfLifeDays: body.shelfLifeDays === null || body.shelfLifeDays === "" ? null : int(body.shelfLifeDays, "shelfLifeDays", { min: 1 }),
    }),
    ...(typeof body.autoPlanning === "boolean" && { autoPlanning: body.autoPlanning }),
    ...(typeof body.isActive === "boolean" && { isActive: body.isActive }),
  };
  if (body.preferredVendorId !== undefined) {
    data.preferredVendorId = body.preferredVendorId ? uuid(body.preferredVendorId, "preferredVendorId") : null;
  }
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
};

const ITEM_INCLUDE = {
  centralStock: true,
  categoryRef: { select: { name: true, level: true, isPerishable: true, defaultShelfLifeDays: true } },
  preferredVendor: { select: { id: true, vendorName: true } },
};

const listItems = async ({ category, search } = {}) =>
  prisma.item.findMany({
    where: {
      ...(category && { category: { in: await categoryWithDescendants(category) } }),
      ...(search && {
        OR: [
          { itemName: { contains: search, mode: "insensitive" } },
          { sku: { contains: search, mode: "insensitive" } },
          { barcode: search },
        ],
      }),
    },
    include: ITEM_INCLUDE,
    orderBy: { itemName: "asc" },
  });

const getItem = async (id) => {
  const item = await prisma.item.findUnique({
    where: { id: uuid(id, "id") },
    include: {
      ...ITEM_INCLUDE,
      outletStocks: { include: { department: true } },
      transactionLogs: { orderBy: [{ timestamp: "desc" }, { seq: "desc" }], take: 50 },
      batches: { where: { quantityRemaining: { gt: 0 } }, orderBy: [{ expiryDate: "asc" }, { receivedAt: "asc" }] },
    },
  });
  if (!item) throw notFound("Item");
  return item;
};

const createItem = async (body) => {
  const data = parseItem(body);
  await assertItemCategory(data.category);
  return prisma.item.create({
    data: {
      costPrice: 0,
      minStockLevel: 0,
      maxStockLevel: 0,
      reorderPoint: 0,
      ...data,
      centralStock: { create: {} },
    },
    include: ITEM_INCLUDE,
  });
};

const updateItem = async (id, body) => {
  const data = parseItem(body, { partial: true });
  await assertItemCategory(data.category);
  // Cost is derived from receipts once stock exists; changing it here would desync totalValue.
  delete data.costPrice;
  return prisma.item.update({ where: { id: uuid(id, "id") }, data, include: ITEM_INCLUDE });
};

// ── Outlets (kitchens, bars, departments) ────────────────────────────────

const words = (code) => code.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// Sensible defaults for an outlet's code, display name and type from its main outlet and section.
const outletDefaults = (mainOutlet, subDepartment) => ({
  code: subDepartment === "NONE" ? mainOutlet : `${mainOutlet}-${subDepartment}`,
  name: `${mainOutlet === "FB" ? "F&B" : words(mainOutlet)}${subDepartment === "NONE" ? "" : ` – ${words(subDepartment)}`}`,
  outletType:
    mainOutlet === "MAIN_KITCHEN" || (mainOutlet === "FB" && subDepartment !== "NONE")
      ? "KITCHEN"
      : { FB: "RESTAURANT", BAR: "BAR", HOUSEKEEPING: "HOUSEKEEPING", FRONT_OFFICE: "FRONT_OFFICE", MAINTENANCE: "ENGINEERING" }[mainOutlet] ?? "OTHER",
});

const listDepartments = ({ includeInactive } = {}) =>
  prisma.outletDepartment.findMany({
    where: includeInactive === "true" ? {} : { isActive: true },
    orderBy: [{ mainOutlet: "asc" }, { subDepartment: "asc" }],
  });

const createDepartment = (body) => {
  const mainOutlet = oneOf(body.mainOutlet, "mainOutlet", MAIN_OUTLETS);
  const subDepartment = oneOf(body.subDepartment ?? "NONE", "subDepartment", SUB_DEPARTMENTS);
  const defaults = outletDefaults(mainOutlet, subDepartment);
  return prisma.outletDepartment.create({
    data: {
      mainOutlet,
      subDepartment,
      code: text(body.code, "code", { optional: true })?.toUpperCase() ?? defaults.code,
      name: text(body.name, "name", { optional: true }) ?? defaults.name,
      outletType: oneOf(body.outletType, "outletType", OUTLET_TYPES, { optional: true }) ?? defaults.outletType,
      costCenter: text(body.costCenter, "costCenter", { optional: true }),
    },
  });
};

const updateDepartment = (id, body) => {
  const data = {
    name: text(body.name, "name", { optional: true }),
    outletType: oneOf(body.outletType, "outletType", OUTLET_TYPES, { optional: true }),
    ...(body.costCenter !== undefined && { costCenter: text(body.costCenter, "costCenter", { optional: true }) ?? null }),
    ...(typeof body.isActive === "boolean" && { isActive: body.isActive }),
  };
  return prisma.outletDepartment.update({
    where: { id: uuid(id, "id") },
    data: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)),
  });
};

const outletStock = (outletDepartmentId) =>
  prisma.outletStock.findMany({
    where: { ...(outletDepartmentId && { outletDepartmentId: uuid(outletDepartmentId, "outletDepartmentId") }) },
    include: { department: true, item: { select: { id: true, sku: true, itemName: true, unitOfMeasure: true, costPrice: true } } },
    orderBy: { item: { itemName: "asc" } },
  });

const adjustStock = (body, createdBy) => {
  const itemId = uuid(body.itemId, "itemId");
  const quantityChange = quantity(body.quantityChange, "quantityChange", { signed: true });
  if (quantityChange === 0) throw badRequest("quantityChange must not be zero");
  const remarks = text(body.reason, "reason");
  return inTransaction(prisma, (tx) => adjustCentral(tx, { itemId, quantityChange, remarks, createdBy }));
};

// Waste from the central store (location 'CENTRAL') or from an outlet (department UUID).
const recordWaste = (body, createdBy) => {
  const itemId = uuid(body.itemId, "itemId");
  const wasted = quantity(body.quantity, "quantity", { positive: true });
  const remarks = text(body.reason, "reason");
  const location = body.location ?? "CENTRAL";
  return inTransaction(prisma, (tx) =>
    location === "CENTRAL"
      ? issueFromCentral(tx, { itemId, quantity: wasted, type: "WASTE", destination: "WASTE_BIN", remarks, createdBy })
      : wasteFromOutlet(tx, { itemId, outletDepartmentId: uuid(location, "location"), quantity: wasted, remarks, createdBy })
  );
};

const listTransactions = ({ itemId, type, limit } = {}) =>
  prisma.inventoryTransaction.findMany({
    where: { ...(itemId && { itemId: uuid(itemId, "itemId") }), ...(type && { type }) },
    include: { item: { select: { sku: true, itemName: true, unitOfMeasure: true } } },
    orderBy: [{ timestamp: "desc" }, { seq: "desc" }],
    take: Math.min(500, Number(limit) || 100),
  });

module.exports = {
  MAIN_OUTLETS,
  SUB_DEPARTMENTS,
  OUTLET_TYPES,
  outletDefaults,
  listCategories,
  createCategory,
  updateCategory,
  categoryWithDescendants,
  listItems,
  getItem,
  createItem,
  updateItem,
  listDepartments,
  createDepartment,
  updateDepartment,
  outletStock,
  adjustStock,
  recordWaste,
  listTransactions,
};
