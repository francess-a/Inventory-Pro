-- Central store architecture.
--  1. Physical schema to snake_case with the blueprint table names (renamed in place, data kept).
--  2. Multi-tier item categories (item_category) replace the flat ItemCategory enum.
--  3. Vendor rating matrix, outlet metadata, item shelf life.
--  4. New ledgers: purchase_inward_ledger, issue_requisition_ledger, stock_batch,
--     closing_stock_daily_valuation, outlet_revenue_daily, audit_log.
--  5. stock_transaction_ledger becomes hash-chained per item; existing rows are sealed here.
--  6. Integrity: CHECK constraints on stock quantities and append-only triggers on the ledgers.

-- ─── 1. Enums ──────────────────────────────────────────────────────────────
ALTER TYPE "AbcCategory" RENAME TO "abc_category";
ALTER TYPE "XyzCategory" RENAME TO "xyz_category";
ALTER TYPE "PurchaseOrderStatus" RENAME TO "purchase_order_status";
ALTER TYPE "MainOutlet" RENAME TO "main_outlet";
ALTER TYPE "SubDepartment" RENAME TO "sub_department";
ALTER TYPE "RequisitionStatus" RENAME TO "requisition_status";
ALTER TYPE "TransactionType" RENAME TO "transaction_type";
ALTER TYPE "UserRole" RENAME TO "user_role";
ALTER TYPE "PriceSource" RENAME TO "price_source";
CREATE TYPE "outlet_type" AS ENUM ('KITCHEN', 'RESTAURANT', 'BAR', 'HOUSEKEEPING', 'FRONT_OFFICE', 'ENGINEERING', 'OTHER');
CREATE TYPE "batch_source" AS ENUM ('PURCHASE', 'OPENING', 'ADJUSTMENT');

-- ─── 2. Tables and columns ─────────────────────────────────────────────────
ALTER TABLE "User" RENAME TO "app_user";
ALTER TABLE "app_user" RENAME COLUMN "passwordHash" TO "password_hash";
ALTER TABLE "app_user" RENAME COLUMN "isActive" TO "is_active";
ALTER TABLE "app_user" RENAME COLUMN "createdAt" TO "created_at";
ALTER TABLE "app_user" RENAME CONSTRAINT "User_pkey" TO "app_user_pkey";
ALTER INDEX "User_email_key" RENAME TO "app_user_email_key";

ALTER TABLE "Item" RENAME TO "inventory_master";
ALTER TABLE "inventory_master" RENAME COLUMN "itemName" TO "item_name";
ALTER TABLE "inventory_master" RENAME COLUMN "costPrice" TO "cost_price";
ALTER TABLE "inventory_master" RENAME COLUMN "unitOfMeasure" TO "unit_of_measure";
ALTER TABLE "inventory_master" RENAME COLUMN "minStockLevel" TO "min_stock_level";
ALTER TABLE "inventory_master" RENAME COLUMN "maxStockLevel" TO "max_stock_level";
ALTER TABLE "inventory_master" RENAME COLUMN "reorderPoint" TO "reorder_point";
ALTER TABLE "inventory_master" RENAME COLUMN "abcCategory" TO "abc_category";
ALTER TABLE "inventory_master" RENAME COLUMN "xyzCategory" TO "xyz_category";
ALTER TABLE "inventory_master" RENAME COLUMN "autoPlanning" TO "auto_planning";
ALTER TABLE "inventory_master" RENAME COLUMN "orderMultiple" TO "order_multiple";
ALTER TABLE "inventory_master" RENAME COLUMN "preferredVendorId" TO "preferred_vendor_id";
ALTER TABLE "inventory_master" RENAME COLUMN "isActive" TO "is_active";
ALTER TABLE "inventory_master" RENAME CONSTRAINT "Item_pkey" TO "inventory_master_pkey";
ALTER TABLE "inventory_master" RENAME CONSTRAINT "Item_preferredVendorId_fkey" TO "inventory_master_preferred_vendor_id_fkey";
ALTER INDEX "Item_sku_key" RENAME TO "inventory_master_sku_key";
ALTER INDEX "Item_barcode_key" RENAME TO "inventory_master_barcode_key";
ALTER INDEX "Item_category_idx" RENAME TO "inventory_master_category_idx";
ALTER TABLE "inventory_master"
  ADD COLUMN "shelf_life_days" INTEGER,
  ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Vendor" RENAME TO "vendor_master";
ALTER TABLE "vendor_master" RENAME COLUMN "vendorName" TO "vendor_name";
ALTER TABLE "vendor_master" RENAME COLUMN "contactName" TO "contact_name";
ALTER TABLE "vendor_master" RENAME COLUMN "leadTimeDays" TO "lead_time_days";
ALTER TABLE "vendor_master" RENAME COLUMN "isActive" TO "is_active";
ALTER TABLE "vendor_master" RENAME CONSTRAINT "Vendor_pkey" TO "vendor_master_pkey";
ALTER TABLE "vendor_master"
  ADD COLUMN "address" TEXT,
  ADD COLUMN "tax_id" TEXT,
  ADD COLUMN "payment_terms_days" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "rating_matrix" JSONB,
  ADD COLUMN "overall_rating" DECIMAL(5,2),
  ADD COLUMN "rated_at" TIMESTAMP(3),
  ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "PurchaseOrder" RENAME TO "purchase_order";
ALTER TABLE "purchase_order" RENAME COLUMN "poNumber" TO "po_number";
ALTER TABLE "purchase_order" RENAME COLUMN "vendorId" TO "vendor_id";
ALTER TABLE "purchase_order" RENAME COLUMN "createdAt" TO "created_at";
ALTER TABLE "purchase_order" RENAME COLUMN "sentAt" TO "sent_at";
ALTER TABLE "purchase_order" RENAME COLUMN "expectedDeliveryAt" TO "expected_delivery_at";
ALTER TABLE "purchase_order" RENAME COLUMN "receivedAt" TO "received_at";
ALTER TABLE "purchase_order" RENAME COLUMN "invoiceNumber" TO "invoice_number";
ALTER TABLE "purchase_order" RENAME CONSTRAINT "PurchaseOrder_pkey" TO "purchase_order_pkey";
ALTER TABLE "purchase_order" RENAME CONSTRAINT "PurchaseOrder_vendorId_fkey" TO "purchase_order_vendor_id_fkey";
ALTER INDEX "PurchaseOrder_poNumber_key" RENAME TO "purchase_order_po_number_key";
ALTER INDEX "PurchaseOrder_vendorId_idx" RENAME TO "purchase_order_vendor_id_idx";
ALTER INDEX "PurchaseOrder_status_idx" RENAME TO "purchase_order_status_idx";

ALTER TABLE "PurchaseOrderItem" RENAME TO "purchase_order_item";
ALTER TABLE "purchase_order_item" RENAME COLUMN "poId" TO "po_id";
ALTER TABLE "purchase_order_item" RENAME COLUMN "itemId" TO "item_id";
ALTER TABLE "purchase_order_item" RENAME COLUMN "quantityOrdered" TO "quantity_ordered";
ALTER TABLE "purchase_order_item" RENAME COLUMN "quantityReceived" TO "quantity_received";
ALTER TABLE "purchase_order_item" RENAME COLUMN "quantityRejected" TO "quantity_rejected";
ALTER TABLE "purchase_order_item" RENAME COLUMN "rejectionReason" TO "rejection_reason";
ALTER TABLE "purchase_order_item" RENAME COLUMN "unitPrice" TO "unit_price";
ALTER TABLE "purchase_order_item" RENAME CONSTRAINT "PurchaseOrderItem_pkey" TO "purchase_order_item_pkey";
ALTER TABLE "purchase_order_item" RENAME CONSTRAINT "PurchaseOrderItem_poId_fkey" TO "purchase_order_item_po_id_fkey";
ALTER TABLE "purchase_order_item" RENAME CONSTRAINT "PurchaseOrderItem_itemId_fkey" TO "purchase_order_item_item_id_fkey";
ALTER INDEX "PurchaseOrderItem_poId_idx" RENAME TO "purchase_order_item_po_id_idx";
ALTER INDEX "PurchaseOrderItem_itemId_idx" RENAME TO "purchase_order_item_item_id_idx";

ALTER TABLE "OutletDepartment" RENAME TO "outlet_master";
ALTER TABLE "outlet_master" RENAME COLUMN "mainOutlet" TO "main_outlet";
ALTER TABLE "outlet_master" RENAME COLUMN "subDepartment" TO "sub_department";
ALTER TABLE "outlet_master" RENAME CONSTRAINT "OutletDepartment_pkey" TO "outlet_master_pkey";
ALTER INDEX "OutletDepartment_mainOutlet_subDepartment_key" RENAME TO "outlet_master_main_outlet_sub_department_key";
ALTER TABLE "outlet_master"
  ADD COLUMN "code" TEXT,
  ADD COLUMN "name" TEXT,
  ADD COLUMN "outlet_type" "outlet_type" NOT NULL DEFAULT 'OTHER',
  ADD COLUMN "cost_center" TEXT,
  ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "outlet_master" SET
  "code" = "main_outlet"::text || CASE WHEN "sub_department" = 'NONE' THEN '' ELSE '-' || "sub_department"::text END,
  "name" = CASE "main_outlet"
             WHEN 'FB' THEN 'F&B'
             ELSE initcap(replace("main_outlet"::text, '_', ' '))
           END || CASE WHEN "sub_department" = 'NONE' THEN '' ELSE ' – ' || initcap(replace("sub_department"::text, '_', ' ')) END,
  "outlet_type" = (CASE
             WHEN "main_outlet" = 'MAIN_KITCHEN' THEN 'KITCHEN'
             WHEN "main_outlet" = 'FB' AND "sub_department" <> 'NONE' THEN 'KITCHEN'
             WHEN "main_outlet" = 'FB' THEN 'RESTAURANT'
             WHEN "main_outlet" = 'BAR' THEN 'BAR'
             WHEN "main_outlet" = 'HOUSEKEEPING' THEN 'HOUSEKEEPING'
             WHEN "main_outlet" = 'FRONT_OFFICE' THEN 'FRONT_OFFICE'
             WHEN "main_outlet" = 'MAINTENANCE' THEN 'ENGINEERING'
             ELSE 'OTHER'
           END)::"outlet_type";
ALTER TABLE "outlet_master" ALTER COLUMN "code" SET NOT NULL, ALTER COLUMN "name" SET NOT NULL;
CREATE UNIQUE INDEX "outlet_master_code_key" ON "outlet_master"("code");

ALTER TABLE "CentralStock" RENAME TO "central_stock";
ALTER TABLE "central_stock" RENAME COLUMN "itemId" TO "item_id";
ALTER TABLE "central_stock" RENAME COLUMN "quantityOnHand" TO "quantity_on_hand";
ALTER TABLE "central_stock" RENAME COLUMN "totalValue" TO "total_value";
ALTER TABLE "central_stock" RENAME CONSTRAINT "CentralStock_pkey" TO "central_stock_pkey";
ALTER TABLE "central_stock" RENAME CONSTRAINT "CentralStock_itemId_fkey" TO "central_stock_item_id_fkey";
ALTER INDEX "CentralStock_itemId_key" RENAME TO "central_stock_item_id_key";

ALTER TABLE "OutletStock" RENAME TO "outlet_stock";
ALTER TABLE "outlet_stock" RENAME COLUMN "outletDepartmentId" TO "outlet_department_id";
ALTER TABLE "outlet_stock" RENAME COLUMN "itemId" TO "item_id";
ALTER TABLE "outlet_stock" RENAME COLUMN "quantityOnHand" TO "quantity_on_hand";
ALTER TABLE "outlet_stock" RENAME CONSTRAINT "OutletStock_pkey" TO "outlet_stock_pkey";
ALTER TABLE "outlet_stock" RENAME CONSTRAINT "OutletStock_itemId_fkey" TO "outlet_stock_item_id_fkey";
ALTER TABLE "outlet_stock" RENAME CONSTRAINT "OutletStock_outletDepartmentId_fkey" TO "outlet_stock_outlet_department_id_fkey";
ALTER INDEX "OutletStock_itemId_idx" RENAME TO "outlet_stock_item_id_idx";
ALTER INDEX "OutletStock_outletDepartmentId_itemId_key" RENAME TO "outlet_stock_outlet_department_id_item_id_key";

ALTER TABLE "Requisition" RENAME TO "requisition";
ALTER TABLE "requisition" RENAME COLUMN "requisitionNumber" TO "requisition_number";
ALTER TABLE "requisition" RENAME COLUMN "outletDepartmentId" TO "outlet_department_id";
ALTER TABLE "requisition" RENAME COLUMN "requestedBy" TO "requested_by";
ALTER TABLE "requisition" RENAME COLUMN "createdAt" TO "created_at";
ALTER TABLE "requisition" RENAME COLUMN "approvedBy" TO "approved_by";
ALTER TABLE "requisition" RENAME COLUMN "approvedAt" TO "approved_at";
ALTER TABLE "requisition" RENAME COLUMN "issuedBy" TO "issued_by";
ALTER TABLE "requisition" RENAME COLUMN "issuedAt" TO "issued_at";
ALTER TABLE "requisition" RENAME CONSTRAINT "Requisition_pkey" TO "requisition_pkey";
ALTER TABLE "requisition" RENAME CONSTRAINT "Requisition_outletDepartmentId_fkey" TO "requisition_outlet_department_id_fkey";
ALTER INDEX "Requisition_requisitionNumber_key" RENAME TO "requisition_requisition_number_key";
ALTER INDEX "Requisition_outletDepartmentId_idx" RENAME TO "requisition_outlet_department_id_idx";
ALTER INDEX "Requisition_status_idx" RENAME TO "requisition_status_idx";
ALTER TABLE "requisition" ADD COLUMN "issue_idempotency_key" TEXT;
CREATE UNIQUE INDEX "requisition_issue_idempotency_key_key" ON "requisition"("issue_idempotency_key");
CREATE INDEX "requisition_created_at_idx" ON "requisition"("created_at");

ALTER TABLE "RequisitionItem" RENAME TO "requisition_item";
ALTER TABLE "requisition_item" RENAME COLUMN "requisitionId" TO "requisition_id";
ALTER TABLE "requisition_item" RENAME COLUMN "itemId" TO "item_id";
ALTER TABLE "requisition_item" RENAME COLUMN "quantityRequested" TO "quantity_requested";
ALTER TABLE "requisition_item" RENAME COLUMN "quantityIssued" TO "quantity_issued";
ALTER TABLE "requisition_item" RENAME COLUMN "unitCost" TO "unit_cost";
ALTER TABLE "requisition_item" RENAME COLUMN "issuedValue" TO "issued_value";
ALTER TABLE "requisition_item" RENAME CONSTRAINT "RequisitionItem_pkey" TO "requisition_item_pkey";
ALTER TABLE "requisition_item" RENAME CONSTRAINT "RequisitionItem_requisitionId_fkey" TO "requisition_item_requisition_id_fkey";
ALTER TABLE "requisition_item" RENAME CONSTRAINT "RequisitionItem_itemId_fkey" TO "requisition_item_item_id_fkey";
ALTER INDEX "RequisitionItem_requisitionId_idx" RENAME TO "requisition_item_requisition_id_idx";
ALTER INDEX "RequisitionItem_itemId_idx" RENAME TO "requisition_item_item_id_idx";

ALTER TABLE "PriceQuote" RENAME TO "price_quote";
ALTER TABLE "price_quote" RENAME COLUMN "itemId" TO "item_id";
ALTER TABLE "price_quote" RENAME COLUMN "vendorId" TO "vendor_id";
ALTER TABLE "price_quote" RENAME COLUMN "unitPrice" TO "unit_price";
ALTER TABLE "price_quote" RENAME COLUMN "recordedAt" TO "recorded_at";
ALTER TABLE "price_quote" RENAME CONSTRAINT "PriceQuote_pkey" TO "price_quote_pkey";
ALTER TABLE "price_quote" RENAME CONSTRAINT "PriceQuote_itemId_fkey" TO "price_quote_item_id_fkey";
ALTER TABLE "price_quote" RENAME CONSTRAINT "PriceQuote_vendorId_fkey" TO "price_quote_vendor_id_fkey";
ALTER INDEX "PriceQuote_itemId_recordedAt_idx" RENAME TO "price_quote_item_id_recorded_at_idx";
ALTER INDEX "PriceQuote_vendorId_idx" RENAME TO "price_quote_vendor_id_idx";

ALTER TABLE "InventoryTransaction" RENAME TO "stock_transaction_ledger";
ALTER TABLE "stock_transaction_ledger" RENAME COLUMN "itemId" TO "item_id";
ALTER TABLE "stock_transaction_ledger" RENAME COLUMN "sourceLocation" TO "source_location";
ALTER TABLE "stock_transaction_ledger" RENAME COLUMN "destinationLocation" TO "destination_location";
ALTER TABLE "stock_transaction_ledger" RENAME COLUMN "unitCost" TO "unit_cost";
ALTER TABLE "stock_transaction_ledger" RENAME COLUMN "transactionValue" TO "transaction_value";
ALTER TABLE "stock_transaction_ledger" RENAME COLUMN "closingStockCentral" TO "closing_stock_central";
ALTER TABLE "stock_transaction_ledger" RENAME COLUMN "closingStockCentralValue" TO "closing_stock_central_value";
ALTER TABLE "stock_transaction_ledger" RENAME COLUMN "referenceId" TO "reference_id";
ALTER TABLE "stock_transaction_ledger" RENAME CONSTRAINT "InventoryTransaction_pkey" TO "stock_transaction_ledger_pkey";
ALTER TABLE "stock_transaction_ledger" RENAME CONSTRAINT "InventoryTransaction_itemId_fkey" TO "stock_transaction_ledger_item_id_fkey";
ALTER INDEX "InventoryTransaction_itemId_timestamp_idx" RENAME TO "stock_transaction_ledger_item_id_timestamp_idx";
ALTER INDEX "InventoryTransaction_type_timestamp_idx" RENAME TO "stock_transaction_ledger_type_timestamp_idx";
ALTER TABLE "stock_transaction_ledger"
  ADD COLUMN "seq" BIGSERIAL NOT NULL,
  ADD COLUMN "created_by" TEXT,
  ADD COLUMN "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "prev_hash" TEXT,
  ADD COLUMN "entry_hash" TEXT;
CREATE INDEX "stock_transaction_ledger_timestamp_idx" ON "stock_transaction_ledger"("timestamp");

-- ─── 3. Item categories (replaces the ItemCategory enum) ──────────────────
CREATE TABLE "item_category" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" UUID,
    "level" INTEGER NOT NULL,
    "is_perishable" BOOLEAN NOT NULL DEFAULT false,
    "default_shelf_life_days" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "item_category_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "item_category_level_check" CHECK ("level" BETWEEN 1 AND 3),
    CONSTRAINT "item_category_shelf_life_check" CHECK ("default_shelf_life_days" IS NULL OR "default_shelf_life_days" > 0)
);
CREATE UNIQUE INDEX "item_category_code_key" ON "item_category"("code");
CREATE INDEX "item_category_parent_id_idx" ON "item_category"("parent_id");
ALTER TABLE "item_category" ADD CONSTRAINT "item_category_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "item_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Standard hotel tree. Codes of the old enum values are kept so existing items map 1:1.
INSERT INTO "item_category" ("id", "code", "name", "parent_id", "level", "is_perishable", "default_shelf_life_days", "sort_order")
SELECT gen_random_uuid(), c.code, c.name, NULL, 1, false, NULL, c.sort
FROM (VALUES ('FOOD', 'Food', 1), ('BEVERAGE', 'Beverages', 2), ('NON_FOOD', 'Non-food & operating supplies', 3)) AS c(code, name, sort);

INSERT INTO "item_category" ("id", "code", "name", "parent_id", "level", "is_perishable", "default_shelf_life_days", "sort_order")
SELECT gen_random_uuid(), c.code, c.name, p.id, 2, c.perishable, c.shelf, c.sort
FROM (VALUES
    ('FOOD', 'GROCERY', 'Groceries', false, 180, 1),
    ('FOOD', 'VEGETABLE', 'Fruits & vegetables', true, 5, 2),
    ('FOOD', 'DAIRY', 'Dairy', true, 7, 3),
    ('FOOD', 'MEAT_POULTRY', 'Meat & poultry', true, 3, 4),
    ('FOOD', 'SEAFOOD', 'Seafood', true, 2, 5),
    ('BEVERAGE', 'BAR', 'Bar & liquor', false, NULL, 1),
    ('BEVERAGE', 'SOFT_BEVERAGES', 'Soft beverages, juices & water', false, 270, 2),
    ('NON_FOOD', 'LINEN', 'Linen', false, NULL, 1),
    ('NON_FOOD', 'AMENITIES', 'Guest amenities', false, NULL, 2),
    ('NON_FOOD', 'CLEANING', 'Cleaning & chemicals', false, NULL, 3),
    ('NON_FOOD', 'FRONT_OFFICE', 'Front office & stationery', false, NULL, 4),
    ('NON_FOOD', 'SPARES', 'Engineering spares', false, NULL, 5)
  ) AS c(parent, code, name, perishable, shelf, sort)
JOIN "item_category" p ON p."code" = c.parent;

INSERT INTO "item_category" ("id", "code", "name", "parent_id", "level", "is_perishable", "default_shelf_life_days", "sort_order")
SELECT gen_random_uuid(), c.code, c.name, p.id, 3, c.perishable, c.shelf, c.sort
FROM (VALUES
    ('GROCERY', 'DRY_GOODS', 'Dry goods (rice, flour, pulses)', false, 365, 1),
    ('MEAT_POULTRY', 'CHICKEN', 'Chicken', true, 3, 1),
    ('MEAT_POULTRY', 'MUTTON', 'Mutton', true, 3, 2),
    ('MEAT_POULTRY', 'BEEF', 'Beef', true, 3, 3),
    ('MEAT_POULTRY', 'PORK', 'Pork', true, 3, 4),
    ('MEAT_POULTRY', 'BIRDS', 'Birds & game', true, 3, 5)
  ) AS c(parent, code, name, perishable, shelf, sort)
JOIN "item_category" p ON p."code" = c.parent;

ALTER TABLE "inventory_master" ALTER COLUMN "category" TYPE TEXT USING "category"::text;
DROP TYPE "ItemCategory";
ALTER TABLE "inventory_master" ADD CONSTRAINT "inventory_master_category_fkey" FOREIGN KEY ("category") REFERENCES "item_category"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_master" ADD CONSTRAINT "inventory_master_shelf_life_check" CHECK ("shelf_life_days" IS NULL OR "shelf_life_days" > 0);
ALTER TABLE "inventory_master" ADD CONSTRAINT "inventory_master_levels_check"
  CHECK ("min_stock_level" >= 0 AND "reorder_point" >= 0 AND "max_stock_level" >= 0 AND "order_multiple" > 0);

-- ─── 4. Seal the existing stock ledger as a per-item hash chain ────────────
-- entry_hash = sha256(prev_hash ␟ id ␟ item_id ␟ type ␟ source ␟ destination ␟ quantity ␟ unit_cost
--                     ␟ value ␟ closing qty ␟ closing value ␟ reference ␟ remarks ␟ created_by ␟ timestamp)
-- with ␟ = chr(31). src/services/ledger.js computes exactly the same string.
UPDATE "stock_transaction_ledger" l SET "seq" = o.rn, "recorded_at" = l."timestamp"
FROM (SELECT "id", row_number() OVER (ORDER BY "timestamp", "id") AS rn FROM "stock_transaction_ledger") o
WHERE o."id" = l."id";
SELECT setval(pg_get_serial_sequence('"stock_transaction_ledger"', 'seq'), COALESCE((SELECT max("seq") FROM "stock_transaction_ledger"), 0) + 1, false);

DO $$
DECLARE
  r RECORD;
  prev TEXT;
  last_item UUID := NULL;
  h TEXT;
BEGIN
  FOR r IN SELECT * FROM "stock_transaction_ledger" ORDER BY "item_id", "seq" LOOP
    IF last_item IS DISTINCT FROM r."item_id" THEN
      prev := 'GENESIS';
      last_item := r."item_id";
    END IF;
    h := encode(sha256(convert_to(concat_ws(chr(31),
           prev, r."id"::text, r."item_id"::text, r."type"::text, r."source_location", r."destination_location",
           r."quantity"::text, r."unit_cost"::text, r."transaction_value"::text,
           r."closing_stock_central"::text, r."closing_stock_central_value"::text,
           COALESCE(r."reference_id", ''), COALESCE(r."remarks", ''), COALESCE(r."created_by", ''),
           to_char(r."timestamp", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), 'UTF8')), 'hex');
    UPDATE "stock_transaction_ledger" SET "prev_hash" = prev, "entry_hash" = h WHERE "id" = r."id";
    prev := h;
  END LOOP;
END $$;

ALTER TABLE "stock_transaction_ledger" ALTER COLUMN "prev_hash" SET NOT NULL, ALTER COLUMN "entry_hash" SET NOT NULL;
CREATE UNIQUE INDEX "stock_transaction_ledger_seq_key" ON "stock_transaction_ledger"("seq");
CREATE UNIQUE INDEX "stock_transaction_ledger_entry_hash_key" ON "stock_transaction_ledger"("entry_hash");
CREATE UNIQUE INDEX "stock_transaction_ledger_item_id_prev_hash_key" ON "stock_transaction_ledger"("item_id", "prev_hash");

-- ─── 5. New ledgers and tables ─────────────────────────────────────────────
CREATE TABLE "purchase_inward_ledger" (
    "id" UUID NOT NULL,
    "grn_number" TEXT NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "purchase_order_item_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "batch_number" TEXT NOT NULL,
    "manufacture_date" DATE,
    "expiry_date" DATE,
    "quantity_received" DECIMAL(12,3) NOT NULL,
    "quantity_rejected" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "rejection_reason" TEXT,
    "unit_of_measure" TEXT NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "line_value" DECIMAL(14,2) NOT NULL,
    "invoice_number" TEXT,
    "invoice_date" DATE,
    "received_by" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "transaction_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_inward_ledger_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "purchase_inward_ledger_quantity_check" CHECK ("quantity_received" >= 0 AND "quantity_rejected" >= 0 AND "quantity_received" + "quantity_rejected" > 0),
    CONSTRAINT "purchase_inward_ledger_stock_link_check" CHECK (("quantity_received" > 0) = ("transaction_id" IS NOT NULL)),
    CONSTRAINT "purchase_inward_ledger_dates_check" CHECK ("expiry_date" IS NULL OR "manufacture_date" IS NULL OR "expiry_date" >= "manufacture_date")
);
CREATE UNIQUE INDEX "purchase_inward_ledger_transaction_id_key" ON "purchase_inward_ledger"("transaction_id");
CREATE INDEX "purchase_inward_ledger_item_id_received_at_idx" ON "purchase_inward_ledger"("item_id", "received_at");
CREATE INDEX "purchase_inward_ledger_vendor_id_received_at_idx" ON "purchase_inward_ledger"("vendor_id", "received_at");
CREATE INDEX "purchase_inward_ledger_purchase_order_id_idx" ON "purchase_inward_ledger"("purchase_order_id");
CREATE INDEX "purchase_inward_ledger_grn_number_idx" ON "purchase_inward_ledger"("grn_number");
CREATE INDEX "purchase_inward_ledger_invoice_number_idx" ON "purchase_inward_ledger"("invoice_number");
CREATE INDEX "purchase_inward_ledger_expiry_date_idx" ON "purchase_inward_ledger"("expiry_date");
ALTER TABLE "purchase_inward_ledger" ADD CONSTRAINT "purchase_inward_ledger_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_inward_ledger" ADD CONSTRAINT "purchase_inward_ledger_purchase_order_item_id_fkey" FOREIGN KEY ("purchase_order_item_id") REFERENCES "purchase_order_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_inward_ledger" ADD CONSTRAINT "purchase_inward_ledger_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_inward_ledger" ADD CONSTRAINT "purchase_inward_ledger_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendor_master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_inward_ledger" ADD CONSTRAINT "purchase_inward_ledger_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "stock_transaction_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "stock_batch" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "inward_id" UUID,
    "source" "batch_source" NOT NULL,
    "batch_number" TEXT NOT NULL,
    "expiry_date" DATE,
    "received_at" TIMESTAMP(3) NOT NULL,
    "unit_cost" DECIMAL(12,2) NOT NULL,
    "quantity_received" DECIMAL(12,3) NOT NULL,
    "quantity_remaining" DECIMAL(12,3) NOT NULL,

    CONSTRAINT "stock_batch_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "stock_batch_quantity_check" CHECK ("quantity_remaining" >= 0 AND "quantity_remaining" <= "quantity_received")
);
CREATE UNIQUE INDEX "stock_batch_inward_id_key" ON "stock_batch"("inward_id");
CREATE INDEX "stock_batch_item_id_expiry_date_received_at_idx" ON "stock_batch"("item_id", "expiry_date", "received_at");
ALTER TABLE "stock_batch" ADD CONSTRAINT "stock_batch_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_batch" ADD CONSTRAINT "stock_batch_inward_id_fkey" FOREIGN KEY ("inward_id") REFERENCES "purchase_inward_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "issue_requisition_ledger" (
    "id" UUID NOT NULL,
    "issue_number" TEXT NOT NULL,
    "requisition_id" UUID NOT NULL,
    "requisition_item_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "outlet_department_id" UUID NOT NULL,
    "quantity_requested" DECIMAL(12,3) NOT NULL,
    "quantity_issued" DECIMAL(12,3) NOT NULL,
    "unit_cost" DECIMAL(12,2) NOT NULL,
    "issue_value" DECIMAL(14,2) NOT NULL,
    "batch_allocations" JSONB NOT NULL,
    "issued_by" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL,
    "transaction_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "issue_requisition_ledger_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "issue_requisition_ledger_quantity_check" CHECK ("quantity_issued" > 0 AND "quantity_issued" <= "quantity_requested")
);
CREATE UNIQUE INDEX "issue_requisition_ledger_requisition_item_id_key" ON "issue_requisition_ledger"("requisition_item_id");
CREATE UNIQUE INDEX "issue_requisition_ledger_transaction_id_key" ON "issue_requisition_ledger"("transaction_id");
CREATE INDEX "issue_requisition_ledger_outlet_department_id_issued_at_idx" ON "issue_requisition_ledger"("outlet_department_id", "issued_at");
CREATE INDEX "issue_requisition_ledger_item_id_issued_at_idx" ON "issue_requisition_ledger"("item_id", "issued_at");
CREATE INDEX "issue_requisition_ledger_requisition_id_idx" ON "issue_requisition_ledger"("requisition_id");
ALTER TABLE "issue_requisition_ledger" ADD CONSTRAINT "issue_requisition_ledger_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "requisition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "issue_requisition_ledger" ADD CONSTRAINT "issue_requisition_ledger_requisition_item_id_fkey" FOREIGN KEY ("requisition_item_id") REFERENCES "requisition_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "issue_requisition_ledger" ADD CONSTRAINT "issue_requisition_ledger_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "issue_requisition_ledger" ADD CONSTRAINT "issue_requisition_ledger_outlet_department_id_fkey" FOREIGN KEY ("outlet_department_id") REFERENCES "outlet_master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "issue_requisition_ledger" ADD CONSTRAINT "issue_requisition_ledger_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "stock_transaction_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "closing_stock_daily_valuation" (
    "business_date" DATE NOT NULL,
    "item_id" UUID NOT NULL,
    "opening_qty" DECIMAL(12,3) NOT NULL,
    "opening_value" DECIMAL(14,2) NOT NULL,
    "received_qty" DECIMAL(12,3) NOT NULL,
    "received_value" DECIMAL(14,2) NOT NULL,
    "issued_qty" DECIMAL(12,3) NOT NULL,
    "issued_value" DECIMAL(14,2) NOT NULL,
    "waste_qty" DECIMAL(12,3) NOT NULL,
    "waste_value" DECIMAL(14,2) NOT NULL,
    "adjustment_qty" DECIMAL(12,3) NOT NULL,
    "adjustment_value" DECIMAL(14,2) NOT NULL,
    "closing_qty" DECIMAL(12,3) NOT NULL,
    "wac_unit_cost" DECIMAL(12,2) NOT NULL,
    "closing_value_wac" DECIMAL(14,2) NOT NULL,
    "closing_value_fifo" DECIMAL(14,2) NOT NULL,
    "avg_daily_issue_value" DECIMAL(14,2) NOT NULL,
    "days_on_hand" DECIMAL(10,1),
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "closing_stock_daily_valuation_pkey" PRIMARY KEY ("business_date","item_id"),
    CONSTRAINT "closing_stock_daily_valuation_closing_check" CHECK ("closing_qty" >= 0)
);
CREATE INDEX "closing_stock_daily_valuation_item_id_business_date_idx" ON "closing_stock_daily_valuation"("item_id", "business_date");
ALTER TABLE "closing_stock_daily_valuation" ADD CONSTRAINT "closing_stock_daily_valuation_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "outlet_revenue_daily" (
    "outlet_department_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "revenue" DECIMAL(14,2) NOT NULL,
    "recorded_by" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outlet_revenue_daily_pkey" PRIMARY KEY ("outlet_department_id","business_date"),
    CONSTRAINT "outlet_revenue_daily_revenue_check" CHECK ("revenue" >= 0)
);
CREATE INDEX "outlet_revenue_daily_business_date_idx" ON "outlet_revenue_daily"("business_date");
ALTER TABLE "outlet_revenue_daily" ADD CONSTRAINT "outlet_revenue_daily_outlet_department_id_fkey" FOREIGN KEY ("outlet_department_id") REFERENCES "outlet_master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" TEXT,
    "actor_name" TEXT,
    "actor_role" TEXT,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "entity_id" TEXT,
    "request_body" JSONB,
    "ip_address" TEXT,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "audit_log_occurred_at_idx" ON "audit_log"("occurred_at");
CREATE INDEX "audit_log_actor_id_occurred_at_idx" ON "audit_log"("actor_id", "occurred_at");
CREATE INDEX "audit_log_entity_id_idx" ON "audit_log"("entity_id");

-- ─── 6. Back-fill the new ledgers from the existing history ───────────────
-- Goods receipts: one inward row per PURCHASE_RECEIPT movement, matched to its PO line.
INSERT INTO "purchase_inward_ledger" (
  "id", "grn_number", "purchase_order_id", "purchase_order_item_id", "item_id", "vendor_id", "batch_number",
  "expiry_date", "quantity_received", "unit_of_measure", "unit_price", "line_value", "invoice_number",
  "received_by", "received_at", "transaction_id")
SELECT gen_random_uuid(), 'GRN-' || po."po_number", po."id", pol."id", t."item_id", po."vendor_id",
       'LEGACY-' || to_char(t."timestamp", 'YYYYMMDD'),
       CASE WHEN c."is_perishable" THEN (t."timestamp" + make_interval(days => COALESCE(i."shelf_life_days", c."default_shelf_life_days")))::date END,
       t."quantity", i."unit_of_measure", t."unit_cost", t."transaction_value", po."invoice_number",
       'migration', t."timestamp", t."id"
FROM "stock_transaction_ledger" t
JOIN "purchase_order" po ON po."id"::text = t."reference_id"
JOIN LATERAL (
  SELECT x."id" FROM "purchase_order_item" x WHERE x."po_id" = po."id" AND x."item_id" = t."item_id" ORDER BY x."id" LIMIT 1
) pol ON true
JOIN "inventory_master" i ON i."id" = t."item_id"
JOIN "item_category" c ON c."code" = i."category"
WHERE t."type" = 'PURCHASE_RECEIPT' AND t."quantity" > 0;

-- Issues: one row per OUTLET_ISSUE movement, matched to its requisition line.
WITH issues AS (
  SELECT t.*, row_number() OVER (PARTITION BY t."reference_id", t."item_id" ORDER BY t."seq") AS rn
  FROM "stock_transaction_ledger" t WHERE t."type" = 'OUTLET_ISSUE' AND t."quantity" > 0
), lines AS (
  SELECT ri.*, row_number() OVER (PARTITION BY ri."requisition_id", ri."item_id" ORDER BY ri."id") AS rn
  FROM "requisition_item" ri WHERE ri."quantity_issued" > 0
)
INSERT INTO "issue_requisition_ledger" (
  "id", "issue_number", "requisition_id", "requisition_item_id", "item_id", "outlet_department_id",
  "quantity_requested", "quantity_issued", "unit_cost", "issue_value", "batch_allocations", "issued_by", "issued_at", "transaction_id")
SELECT gen_random_uuid(), 'ISS-' || r."requisition_number", r."id", l."id", t."item_id", r."outlet_department_id",
       GREATEST(l."quantity_requested", t."quantity"), t."quantity", t."unit_cost", t."transaction_value", '[]'::jsonb,
       COALESCE(r."issued_by", 'migration'), t."timestamp", t."id"
FROM issues t
JOIN "requisition" r ON r."id"::text = t."reference_id"
JOIN lines l ON l."requisition_id" = r."id" AND l."item_id" = t."item_id" AND l.rn = t.rn;

-- Batches for the stock on hand: assume the remaining quantity is from the latest receipts
-- (first in, first out); anything not covered by a receipt becomes an OPENING batch.
WITH layers AS (
  SELECT p.*, cs."quantity_on_hand" AS on_hand,
         sum(p."quantity_received") OVER (PARTITION BY p."item_id" ORDER BY p."received_at" DESC, p."id" ROWS UNBOUNDED PRECEDING) AS cum
  FROM "purchase_inward_ledger" p JOIN "central_stock" cs ON cs."item_id" = p."item_id"
)
INSERT INTO "stock_batch" ("id", "item_id", "inward_id", "source", "batch_number", "expiry_date", "received_at", "unit_cost", "quantity_received", "quantity_remaining")
SELECT gen_random_uuid(), "item_id", "id", 'PURCHASE', "batch_number", "expiry_date", "received_at", "unit_price", "quantity_received",
       LEAST("quantity_received", on_hand - (cum - "quantity_received"))
FROM layers
WHERE on_hand - (cum - "quantity_received") > 0;

INSERT INTO "stock_batch" ("id", "item_id", "source", "batch_number", "received_at", "unit_cost", "quantity_received", "quantity_remaining")
SELECT gen_random_uuid(), cs."item_id", 'OPENING', 'OPENING', CURRENT_TIMESTAMP, i."cost_price",
       cs."quantity_on_hand" - COALESCE(b.qty, 0), cs."quantity_on_hand" - COALESCE(b.qty, 0)
FROM "central_stock" cs
JOIN "inventory_master" i ON i."id" = cs."item_id"
LEFT JOIN (SELECT "item_id", sum("quantity_remaining") AS qty FROM "stock_batch" GROUP BY "item_id") b ON b."item_id" = cs."item_id"
WHERE cs."quantity_on_hand" - COALESCE(b.qty, 0) > 0;

-- ─── 7. Integrity ──────────────────────────────────────────────────────────
ALTER TABLE "central_stock" ADD CONSTRAINT "central_stock_quantity_check" CHECK ("quantity_on_hand" >= 0);
ALTER TABLE "outlet_stock" ADD CONSTRAINT "outlet_stock_quantity_check" CHECK ("quantity_on_hand" >= 0);
ALTER TABLE "requisition_item" ADD CONSTRAINT "requisition_item_quantity_check"
  CHECK ("quantity_requested" > 0 AND "quantity_issued" >= 0 AND "quantity_issued" <= "quantity_requested");
ALTER TABLE "purchase_order_item" ADD CONSTRAINT "purchase_order_item_quantity_check"
  CHECK ("quantity_ordered" > 0 AND "quantity_received" >= 0 AND "quantity_rejected" >= 0
         AND "quantity_received" + "quantity_rejected" <= "quantity_ordered");

-- Ledgers are append-only. UPDATE is always refused. DELETE/TRUNCATE are refused unless the
-- session sets inventory.allow_ledger_purge = 'on' (used only by the demo seed to reset data;
-- production should also revoke DELETE/TRUNCATE from the application role).
CREATE OR REPLACE FUNCTION "ledger_append_only"() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND current_setting('inventory.allow_ledger_purge', true) = 'on' THEN
    RETURN COALESCE(OLD, NULL);
  END IF;
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "stock_transaction_ledger_append_only" BEFORE UPDATE OR DELETE ON "stock_transaction_ledger" FOR EACH ROW EXECUTE FUNCTION "ledger_append_only"();
CREATE TRIGGER "stock_transaction_ledger_no_truncate" BEFORE TRUNCATE ON "stock_transaction_ledger" FOR EACH STATEMENT EXECUTE FUNCTION "ledger_append_only"();
CREATE TRIGGER "purchase_inward_ledger_append_only" BEFORE UPDATE OR DELETE ON "purchase_inward_ledger" FOR EACH ROW EXECUTE FUNCTION "ledger_append_only"();
CREATE TRIGGER "purchase_inward_ledger_no_truncate" BEFORE TRUNCATE ON "purchase_inward_ledger" FOR EACH STATEMENT EXECUTE FUNCTION "ledger_append_only"();
CREATE TRIGGER "issue_requisition_ledger_append_only" BEFORE UPDATE OR DELETE ON "issue_requisition_ledger" FOR EACH ROW EXECUTE FUNCTION "ledger_append_only"();
CREATE TRIGGER "issue_requisition_ledger_no_truncate" BEFORE TRUNCATE ON "issue_requisition_ledger" FOR EACH STATEMENT EXECUTE FUNCTION "ledger_append_only"();
CREATE TRIGGER "audit_log_append_only" BEFORE UPDATE OR DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION "ledger_append_only"();
CREATE TRIGGER "audit_log_no_truncate" BEFORE TRUNCATE ON "audit_log" FOR EACH STATEMENT EXECUTE FUNCTION "ledger_append_only"();
