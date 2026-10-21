-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ItemCategory" AS ENUM ('GROCERY', 'VEGETABLE', 'DAIRY', 'PORK', 'CHICKEN', 'BEEF', 'BIRDS', 'MUTTON', 'SEAFOOD', 'LINEN', 'AMENITIES', 'SPARES', 'FRONT_OFFICE', 'BAR');

-- CreateEnum
CREATE TYPE "AbcCategory" AS ENUM ('A', 'B', 'C');

-- CreateEnum
CREATE TYPE "XyzCategory" AS ENUM ('X', 'Y', 'Z');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'SENT', 'RECEIVED', 'PARTIALLY_RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MainOutlet" AS ENUM ('FB', 'HOUSEKEEPING', 'FRONT_OFFICE', 'BAR', 'MAINTENANCE', 'MAIN_KITCHEN');

-- CreateEnum
CREATE TYPE "SubDepartment" AS ENUM ('TANDOOR', 'CONTINENTAL', 'BAKERY', 'CHINESE', 'SOUTH_INDIAN', 'NORTH_INDIAN', 'IDLY_DOSA', 'STAFF_FOOD', 'NONE');

-- CreateEnum
CREATE TYPE "RequisitionStatus" AS ENUM ('PENDING', 'APPROVED', 'ISSUED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('PURCHASE_RECEIPT', 'OUTLET_ISSUE', 'ADJUSTMENT', 'WASTE');

-- CreateEnum
CREATE TYPE "PriceSource" AS ENUM ('PURCHASE_RECEIPT', 'VENDOR_QUOTE', 'MARKET_FEED');

-- CreateTable
CREATE TABLE "Item" (
    "id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "barcode" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "category" "ItemCategory" NOT NULL,
    "costPrice" DECIMAL(12,2) NOT NULL,
    "unitOfMeasure" TEXT NOT NULL,
    "minStockLevel" INTEGER NOT NULL,
    "maxStockLevel" INTEGER NOT NULL,
    "reorderPoint" INTEGER NOT NULL,
    "abcCategory" "AbcCategory",
    "xyzCategory" "XyzCategory",
    "autoPlanning" BOOLEAN NOT NULL DEFAULT true,
    "orderMultiple" INTEGER NOT NULL DEFAULT 1,
    "preferredVendorId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" UUID NOT NULL,
    "vendorName" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "leadTimeDays" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" UUID NOT NULL,
    "poNumber" TEXT NOT NULL,
    "vendorId" UUID NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "expectedDeliveryAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "invoiceNumber" TEXT,
    "notes" TEXT,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderItem" (
    "id" UUID NOT NULL,
    "poId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "quantityOrdered" INTEGER NOT NULL,
    "quantityReceived" INTEGER NOT NULL DEFAULT 0,
    "quantityRejected" INTEGER NOT NULL DEFAULT 0,
    "rejectionReason" TEXT,
    "unitPrice" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "PurchaseOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutletDepartment" (
    "id" UUID NOT NULL,
    "mainOutlet" "MainOutlet" NOT NULL,
    "subDepartment" "SubDepartment" NOT NULL DEFAULT 'NONE',

    CONSTRAINT "OutletDepartment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CentralStock" (
    "id" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "quantityOnHand" INTEGER NOT NULL DEFAULT 0,
    "totalValue" DECIMAL(14,2) NOT NULL DEFAULT 0,

    CONSTRAINT "CentralStock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutletStock" (
    "id" UUID NOT NULL,
    "outletDepartmentId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "quantityOnHand" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OutletStock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Requisition" (
    "id" UUID NOT NULL,
    "requisitionNumber" TEXT NOT NULL,
    "outletDepartmentId" UUID NOT NULL,
    "status" "RequisitionStatus" NOT NULL DEFAULT 'PENDING',
    "requestedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "issuedBy" TEXT,
    "issuedAt" TIMESTAMP(3),
    "remarks" TEXT,

    CONSTRAINT "Requisition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequisitionItem" (
    "id" UUID NOT NULL,
    "requisitionId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "quantityRequested" INTEGER NOT NULL,
    "quantityIssued" INTEGER NOT NULL DEFAULT 0,
    "unitCost" DECIMAL(12,2),
    "issuedValue" DECIMAL(14,2) NOT NULL DEFAULT 0,

    CONSTRAINT "RequisitionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryTransaction" (
    "id" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "type" "TransactionType" NOT NULL,
    "sourceLocation" TEXT NOT NULL,
    "destinationLocation" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "transactionValue" DECIMAL(14,2) NOT NULL,
    "closingStockCentral" INTEGER NOT NULL,
    "closingStockCentralValue" DECIMAL(14,2) NOT NULL,
    "referenceId" TEXT,
    "remarks" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceQuote" (
    "id" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "vendorId" UUID,
    "source" "PriceSource" NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "market" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceQuote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Item_sku_key" ON "Item"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "Item_barcode_key" ON "Item"("barcode");

-- CreateIndex
CREATE INDEX "Item_category_idx" ON "Item"("category");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_poNumber_key" ON "PurchaseOrder"("poNumber");

-- CreateIndex
CREATE INDEX "PurchaseOrder_vendorId_idx" ON "PurchaseOrder"("vendorId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_status_idx" ON "PurchaseOrder"("status");

-- CreateIndex
CREATE INDEX "PurchaseOrderItem_poId_idx" ON "PurchaseOrderItem"("poId");

-- CreateIndex
CREATE INDEX "PurchaseOrderItem_itemId_idx" ON "PurchaseOrderItem"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "OutletDepartment_mainOutlet_subDepartment_key" ON "OutletDepartment"("mainOutlet", "subDepartment");

-- CreateIndex
CREATE UNIQUE INDEX "CentralStock_itemId_key" ON "CentralStock"("itemId");

-- CreateIndex
CREATE INDEX "OutletStock_itemId_idx" ON "OutletStock"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "OutletStock_outletDepartmentId_itemId_key" ON "OutletStock"("outletDepartmentId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "Requisition_requisitionNumber_key" ON "Requisition"("requisitionNumber");

-- CreateIndex
CREATE INDEX "Requisition_outletDepartmentId_idx" ON "Requisition"("outletDepartmentId");

-- CreateIndex
CREATE INDEX "Requisition_status_idx" ON "Requisition"("status");

-- CreateIndex
CREATE INDEX "RequisitionItem_requisitionId_idx" ON "RequisitionItem"("requisitionId");

-- CreateIndex
CREATE INDEX "RequisitionItem_itemId_idx" ON "RequisitionItem"("itemId");

-- CreateIndex
CREATE INDEX "InventoryTransaction_itemId_timestamp_idx" ON "InventoryTransaction"("itemId", "timestamp");

-- CreateIndex
CREATE INDEX "InventoryTransaction_type_timestamp_idx" ON "InventoryTransaction"("type", "timestamp");

-- CreateIndex
CREATE INDEX "PriceQuote_itemId_recordedAt_idx" ON "PriceQuote"("itemId", "recordedAt");

-- CreateIndex
CREATE INDEX "PriceQuote_vendorId_idx" ON "PriceQuote"("vendorId");

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_preferredVendorId_fkey" FOREIGN KEY ("preferredVendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CentralStock" ADD CONSTRAINT "CentralStock_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutletStock" ADD CONSTRAINT "OutletStock_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutletStock" ADD CONSTRAINT "OutletStock_outletDepartmentId_fkey" FOREIGN KEY ("outletDepartmentId") REFERENCES "OutletDepartment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Requisition" ADD CONSTRAINT "Requisition_outletDepartmentId_fkey" FOREIGN KEY ("outletDepartmentId") REFERENCES "OutletDepartment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequisitionItem" ADD CONSTRAINT "RequisitionItem_requisitionId_fkey" FOREIGN KEY ("requisitionId") REFERENCES "Requisition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequisitionItem" ADD CONSTRAINT "RequisitionItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryTransaction" ADD CONSTRAINT "InventoryTransaction_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceQuote" ADD CONSTRAINT "PriceQuote_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceQuote" ADD CONSTRAINT "PriceQuote_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

