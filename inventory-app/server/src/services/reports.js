const prisma = require("../db");
const { buildPlan } = require("./replenishment");
const { departmentConsumption } = require("./requisitions");

const dashboard = async () => {
  const [plan, openPurchaseOrders, pendingRequisitions, approvedRequisitions, consumption] = await Promise.all([
    buildPlan(),
    prisma.purchaseOrder.count({ where: { status: { in: ["SENT", "PARTIALLY_RECEIVED"] } } }),
    prisma.requisition.count({ where: { status: "PENDING" } }),
    prisma.requisition.count({ where: { status: "APPROVED" } }),
    departmentConsumption(),
  ]);
  const count = (status) => plan.filter((r) => r.status === status).length;
  return {
    itemCount: plan.length,
    centralStockValue: Math.round(plan.reduce((sum, r) => sum + r.centralValue, 0) * 100) / 100,
    itemsToReorder: plan.filter((r) => r.needsReorder).length,
    suggestedOrderValue: Math.round(plan.reduce((sum, r) => sum + r.suggestedOrderValue, 0) * 100) / 100,
    outOfStock: count("OUT_OF_STOCK"),
    belowSafetyStock: count("BELOW_SAFETY_STOCK"),
    overstock: count("OVERSTOCK"),
    openPurchaseOrders,
    pendingRequisitions,
    approvedRequisitions,
    departmentConsumptionLast30Days: consumption.departments.map((d) => ({
      department: d.department,
      totalValue: d.totalValue,
    })),
  };
};

module.exports = { dashboard };
