// Item master, outlet departments and direct stock operations (adjustments, waste).
const prisma = require("../db");
const { ItemCategory, MainOutlet, SubDepartment } = require("@prisma/client");
const { badRequest, notFound, uuid, quantity, money, text, oneOf } = require("../lib/http");
const { adjustCentral, issueFromCentral, wasteFromOutlet } = require("./ledger");

const CATEGORIES = Object.values(ItemCategory);
const MAIN_OUTLETS = Object.values(MainOutlet);
const SUB_DEPARTMENTS = Object.values(SubDepartment);

const parseItem = (body, { partial = false } = {}) => {
  const opt = { optional: partial };
  const data = {
    sku: text(body.sku, "sku", opt),
    barcode: text(body.barcode, "barcode", opt),
    itemName: text(body.itemName, "itemName", opt),
    category: oneOf(body.category, "category", CATEGORIES, opt),
    costPrice: money(body.costPrice, "costPrice", { optional: true }),
    unitOfMeasure: text(body.unitOfMeasure, "unitOfMeasure", opt),
    minStockLevel: quantity(body.minStockLevel, "minStockLevel", { optional: true }),
    maxStockLevel: quantity(body.maxStockLevel, "maxStockLevel", { optional: true }),
    reorderPoint: quantity(body.reorderPoint, "reorderPoint", { optional: true }),
    orderMultiple: quantity(body.orderMultiple, "orderMultiple", { positive: true, optional: true }),
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
  preferredVendor: { select: { id: true, vendorName: true } },
};

const listItems = ({ category, search } = {}) =>
  prisma.item.findMany({
    where: {
      ...(category && { category }),
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
      transactionLogs: { orderBy: { timestamp: "desc" }, take: 50 },
    },
  });
  if (!item) throw notFound("Item");
  return item;
};

const createItem = (body) => {
  const data = parseItem(body);
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

const updateItem = (id, body) => {
  const data = parseItem(body, { partial: true });
  // Cost is derived from receipts once stock exists; changing it here would desync totalValue.
  delete data.costPrice;
  return prisma.item.update({ where: { id: uuid(id, "id") }, data, include: ITEM_INCLUDE });
};

const listDepartments = () =>
  prisma.outletDepartment.findMany({ orderBy: [{ mainOutlet: "asc" }, { subDepartment: "asc" }] });

const createDepartment = (body) =>
  prisma.outletDepartment.create({
    data: {
      mainOutlet: oneOf(body.mainOutlet, "mainOutlet", MAIN_OUTLETS),
      subDepartment: oneOf(body.subDepartment ?? "NONE", "subDepartment", SUB_DEPARTMENTS),
    },
  });

const outletStock = (outletDepartmentId) =>
  prisma.outletStock.findMany({
    where: { ...(outletDepartmentId && { outletDepartmentId: uuid(outletDepartmentId, "outletDepartmentId") }) },
    include: { department: true, item: { select: { id: true, sku: true, itemName: true, unitOfMeasure: true, costPrice: true } } },
    orderBy: { item: { itemName: "asc" } },
  });

const adjustStock = (body) => {
  const itemId = uuid(body.itemId, "itemId");
  const quantityChange = quantity(body.quantityChange, "quantityChange", { signed: true });
  if (quantityChange === 0) throw badRequest("quantityChange must not be zero");
  const remarks = text(body.reason, "reason");
  return prisma.$transaction((tx) => adjustCentral(tx, { itemId, quantityChange, remarks }));
};

// Waste from the central store (location 'CENTRAL') or from an outlet (department UUID).
const recordWaste = (body) => {
  const itemId = uuid(body.itemId, "itemId");
  const wasted = quantity(body.quantity, "quantity", { positive: true });
  const remarks = text(body.reason, "reason");
  const location = body.location ?? "CENTRAL";
  return prisma.$transaction((tx) =>
    location === "CENTRAL"
      ? issueFromCentral(tx, { itemId, quantity: wasted, type: "WASTE", destination: "WASTE_BIN", remarks })
      : wasteFromOutlet(tx, { itemId, outletDepartmentId: uuid(location, "location"), quantity: wasted, remarks })
  );
};

const listTransactions = ({ itemId, type, limit } = {}) =>
  prisma.inventoryTransaction.findMany({
    where: { ...(itemId && { itemId: uuid(itemId, "itemId") }), ...(type && { type }) },
    include: { item: { select: { sku: true, itemName: true, unitOfMeasure: true } } },
    orderBy: { timestamp: "desc" },
    take: Math.min(500, Number(limit) || 100),
  });

module.exports = {
  CATEGORIES,
  MAIN_OUTLETS,
  SUB_DEPARTMENTS,
  listItems,
  getItem,
  createItem,
  updateItem,
  listDepartments,
  createDepartment,
  outletStock,
  adjustStock,
  recordWaste,
  listTransactions,
};
