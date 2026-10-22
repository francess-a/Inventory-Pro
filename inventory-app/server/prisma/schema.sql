-- Hotel central store: PostgreSQL schema (reference DDL).
--
-- Generated from prisma/schema.prisma plus the integrity rules the migrations add (CHECK
-- constraints, append-only triggers, reference categories). The migrations in
-- prisma/migrations are what actually build and evolve the database (`npx prisma migrate deploy`);
-- this file is the same schema in one place for review, DBAs and code generators. Loading it into
-- an empty database gives a schema identical to the migrated one.
--
-- Blueprint core tables:
--   inventory_master                item master: min/max thresholds, reorder point, ABC/XYZ class
--   vendor_master                   suppliers with rating matrix
--   purchase_inward_ledger          goods received (GRN lines) with batch, expiry and invoice   [append-only]
--   outlet_master                   kitchens, bars and departments
--   issue_requisition_ledger        central store → outlet issues, one row per requisition line [append-only]
--   closing_stock_daily_valuation   end-of-day quantity and value per item (WAC and FIFO)
-- Supporting tables:
--   stock_transaction_ledger        every central-stock movement, SHA-256 hash-chained per item  [append-only]
--   stock_batch                     stock layers consumed first-expiry-first-out
--   central_stock, outlet_stock     current balances (CHECK >= 0)
--   item_category                   three-level category tree
--   purchase_order(_item), requisition(_item), price_quote, outlet_revenue_daily, app_user, audit_log [append-only]

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "abc_category" AS ENUM ('A', 'B', 'C');

-- CreateEnum
CREATE TYPE "xyz_category" AS ENUM ('X', 'Y', 'Z');

-- CreateEnum
CREATE TYPE "purchase_order_status" AS ENUM ('DRAFT', 'SENT', 'RECEIVED', 'PARTIALLY_RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "main_outlet" AS ENUM ('FB', 'HOUSEKEEPING', 'FRONT_OFFICE', 'BAR', 'MAINTENANCE', 'MAIN_KITCHEN');

-- CreateEnum
CREATE TYPE "sub_department" AS ENUM ('TANDOOR', 'CONTINENTAL', 'BAKERY', 'CHINESE', 'SOUTH_INDIAN', 'NORTH_INDIAN', 'IDLY_DOSA', 'STAFF_FOOD', 'NONE');

-- CreateEnum
CREATE TYPE "outlet_type" AS ENUM ('KITCHEN', 'RESTAURANT', 'BAR', 'HOUSEKEEPING', 'FRONT_OFFICE', 'ENGINEERING', 'OTHER');

-- CreateEnum
CREATE TYPE "requisition_status" AS ENUM ('PENDING', 'APPROVED', 'ISSUED', 'REJECTED');

-- CreateEnum
CREATE TYPE "transaction_type" AS ENUM ('PURCHASE_RECEIPT', 'OUTLET_ISSUE', 'ADJUSTMENT', 'WASTE');

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('user', 'approver', 'admin');

-- CreateEnum
CREATE TYPE "price_source" AS ENUM ('PURCHASE_RECEIPT', 'VENDOR_QUOTE', 'MARKET_FEED');

-- CreateEnum
CREATE TYPE "batch_source" AS ENUM ('PURCHASE', 'OPENING', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "user_role" NOT NULL DEFAULT 'user',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_category" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" UUID,
    "level" INTEGER NOT NULL,
    "is_perishable" BOOLEAN NOT NULL DEFAULT false,
    "default_shelf_life_days" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "item_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_master" (
    "id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "barcode" TEXT NOT NULL,
    "item_name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "cost_price" DECIMAL(12,2) NOT NULL,
    "unit_of_measure" TEXT NOT NULL,
    "min_stock_level" DECIMAL(12,3) NOT NULL,
    "max_stock_level" DECIMAL(12,3) NOT NULL,
    "reorder_point" DECIMAL(12,3) NOT NULL,
    "shelf_life_days" INTEGER,
    "abc_category" "abc_category",
    "xyz_category" "xyz_category",
    "auto_planning" BOOLEAN NOT NULL DEFAULT true,
    "order_multiple" DECIMAL(12,3) NOT NULL DEFAULT 1,
    "preferred_vendor_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_master_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_master" (
    "id" UUID NOT NULL,
    "vendor_name" TEXT NOT NULL,
    "contact_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "address" TEXT,
    "tax_id" TEXT,
    "payment_terms_days" INTEGER NOT NULL DEFAULT 30,
    "lead_time_days" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "rating_matrix" JSONB,
    "overall_rating" DECIMAL(5,2),
    "rated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_master_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outlet_master" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "main_outlet" "main_outlet" NOT NULL,
    "sub_department" "sub_department" NOT NULL DEFAULT 'NONE',
    "outlet_type" "outlet_type" NOT NULL DEFAULT 'OTHER',
    "cost_center" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outlet_master_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order" (
    "id" UUID NOT NULL,
    "po_number" TEXT NOT NULL,
    "vendor_id" UUID NOT NULL,
    "status" "purchase_order_status" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "expected_delivery_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3),
    "invoice_number" TEXT,
    "notes" TEXT,

    CONSTRAINT "purchase_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_item" (
    "id" UUID NOT NULL,
    "po_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "quantity_ordered" DECIMAL(12,3) NOT NULL,
    "quantity_received" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "quantity_rejected" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "rejection_reason" TEXT,
    "unit_price" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "purchase_order_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

    CONSTRAINT "purchase_inward_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

    CONSTRAINT "stock_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "central_stock" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "quantity_on_hand" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "total_value" DECIMAL(14,2) NOT NULL DEFAULT 0,

    CONSTRAINT "central_stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outlet_stock" (
    "id" UUID NOT NULL,
    "outlet_department_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "quantity_on_hand" DECIMAL(12,3) NOT NULL DEFAULT 0,

    CONSTRAINT "outlet_stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requisition" (
    "id" UUID NOT NULL,
    "requisition_number" TEXT NOT NULL,
    "outlet_department_id" UUID NOT NULL,
    "status" "requisition_status" NOT NULL DEFAULT 'PENDING',
    "requested_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "issued_by" TEXT,
    "issued_at" TIMESTAMP(3),
    "issue_idempotency_key" TEXT,
    "remarks" TEXT,

    CONSTRAINT "requisition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requisition_item" (
    "id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "quantity_requested" DECIMAL(12,3) NOT NULL,
    "quantity_issued" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "unit_cost" DECIMAL(12,2),
    "issued_value" DECIMAL(14,2) NOT NULL DEFAULT 0,

    CONSTRAINT "requisition_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

    CONSTRAINT "issue_requisition_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transaction_ledger" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "item_id" UUID NOT NULL,
    "type" "transaction_type" NOT NULL,
    "source_location" TEXT NOT NULL,
    "destination_location" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit_cost" DECIMAL(12,2) NOT NULL,
    "transaction_value" DECIMAL(14,2) NOT NULL,
    "closing_stock_central" DECIMAL(12,3) NOT NULL,
    "closing_stock_central_value" DECIMAL(14,2) NOT NULL,
    "reference_id" TEXT,
    "remarks" TEXT,
    "created_by" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prev_hash" TEXT NOT NULL,
    "entry_hash" TEXT NOT NULL,

    CONSTRAINT "stock_transaction_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

    CONSTRAINT "closing_stock_daily_valuation_pkey" PRIMARY KEY ("business_date","item_id")
);

-- CreateTable
CREATE TABLE "outlet_revenue_daily" (
    "outlet_department_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "revenue" DECIMAL(14,2) NOT NULL,
    "recorded_by" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outlet_revenue_daily_pkey" PRIMARY KEY ("outlet_department_id","business_date")
);

-- CreateTable
CREATE TABLE "price_quote" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "vendor_id" UUID,
    "source" "price_source" NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "market" TEXT,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "item_category_code_key" ON "item_category"("code");

-- CreateIndex
CREATE INDEX "item_category_parent_id_idx" ON "item_category"("parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_master_sku_key" ON "inventory_master"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_master_barcode_key" ON "inventory_master"("barcode");

-- CreateIndex
CREATE INDEX "inventory_master_category_idx" ON "inventory_master"("category");

-- CreateIndex
CREATE UNIQUE INDEX "outlet_master_code_key" ON "outlet_master"("code");

-- CreateIndex
CREATE UNIQUE INDEX "outlet_master_main_outlet_sub_department_key" ON "outlet_master"("main_outlet", "sub_department");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_po_number_key" ON "purchase_order"("po_number");

-- CreateIndex
CREATE INDEX "purchase_order_vendor_id_idx" ON "purchase_order"("vendor_id");

-- CreateIndex
CREATE INDEX "purchase_order_status_idx" ON "purchase_order"("status");

-- CreateIndex
CREATE INDEX "purchase_order_item_po_id_idx" ON "purchase_order_item"("po_id");

-- CreateIndex
CREATE INDEX "purchase_order_item_item_id_idx" ON "purchase_order_item"("item_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_inward_ledger_transaction_id_key" ON "purchase_inward_ledger"("transaction_id");

-- CreateIndex
CREATE INDEX "purchase_inward_ledger_item_id_received_at_idx" ON "purchase_inward_ledger"("item_id", "received_at");

-- CreateIndex
CREATE INDEX "purchase_inward_ledger_vendor_id_received_at_idx" ON "purchase_inward_ledger"("vendor_id", "received_at");

-- CreateIndex
CREATE INDEX "purchase_inward_ledger_purchase_order_id_idx" ON "purchase_inward_ledger"("purchase_order_id");

-- CreateIndex
CREATE INDEX "purchase_inward_ledger_grn_number_idx" ON "purchase_inward_ledger"("grn_number");

-- CreateIndex
CREATE INDEX "purchase_inward_ledger_invoice_number_idx" ON "purchase_inward_ledger"("invoice_number");

-- CreateIndex
CREATE INDEX "purchase_inward_ledger_expiry_date_idx" ON "purchase_inward_ledger"("expiry_date");

-- CreateIndex
CREATE UNIQUE INDEX "stock_batch_inward_id_key" ON "stock_batch"("inward_id");

-- CreateIndex
CREATE INDEX "stock_batch_item_id_expiry_date_received_at_idx" ON "stock_batch"("item_id", "expiry_date", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "central_stock_item_id_key" ON "central_stock"("item_id");

-- CreateIndex
CREATE INDEX "outlet_stock_item_id_idx" ON "outlet_stock"("item_id");

-- CreateIndex
CREATE UNIQUE INDEX "outlet_stock_outlet_department_id_item_id_key" ON "outlet_stock"("outlet_department_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "requisition_requisition_number_key" ON "requisition"("requisition_number");

-- CreateIndex
CREATE UNIQUE INDEX "requisition_issue_idempotency_key_key" ON "requisition"("issue_idempotency_key");

-- CreateIndex
CREATE INDEX "requisition_outlet_department_id_idx" ON "requisition"("outlet_department_id");

-- CreateIndex
CREATE INDEX "requisition_status_idx" ON "requisition"("status");

-- CreateIndex
CREATE INDEX "requisition_created_at_idx" ON "requisition"("created_at");

-- CreateIndex
CREATE INDEX "requisition_item_requisition_id_idx" ON "requisition_item"("requisition_id");

-- CreateIndex
CREATE INDEX "requisition_item_item_id_idx" ON "requisition_item"("item_id");

-- CreateIndex
CREATE UNIQUE INDEX "issue_requisition_ledger_requisition_item_id_key" ON "issue_requisition_ledger"("requisition_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "issue_requisition_ledger_transaction_id_key" ON "issue_requisition_ledger"("transaction_id");

-- CreateIndex
CREATE INDEX "issue_requisition_ledger_outlet_department_id_issued_at_idx" ON "issue_requisition_ledger"("outlet_department_id", "issued_at");

-- CreateIndex
CREATE INDEX "issue_requisition_ledger_item_id_issued_at_idx" ON "issue_requisition_ledger"("item_id", "issued_at");

-- CreateIndex
CREATE INDEX "issue_requisition_ledger_requisition_id_idx" ON "issue_requisition_ledger"("requisition_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transaction_ledger_seq_key" ON "stock_transaction_ledger"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transaction_ledger_entry_hash_key" ON "stock_transaction_ledger"("entry_hash");

-- CreateIndex
CREATE INDEX "stock_transaction_ledger_item_id_timestamp_idx" ON "stock_transaction_ledger"("item_id", "timestamp");

-- CreateIndex
CREATE INDEX "stock_transaction_ledger_type_timestamp_idx" ON "stock_transaction_ledger"("type", "timestamp");

-- CreateIndex
CREATE INDEX "stock_transaction_ledger_timestamp_idx" ON "stock_transaction_ledger"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transaction_ledger_item_id_prev_hash_key" ON "stock_transaction_ledger"("item_id", "prev_hash");

-- CreateIndex
CREATE INDEX "closing_stock_daily_valuation_item_id_business_date_idx" ON "closing_stock_daily_valuation"("item_id", "business_date");

-- CreateIndex
CREATE INDEX "outlet_revenue_daily_business_date_idx" ON "outlet_revenue_daily"("business_date");

-- CreateIndex
CREATE INDEX "price_quote_item_id_recorded_at_idx" ON "price_quote"("item_id", "recorded_at");

-- CreateIndex
CREATE INDEX "price_quote_vendor_id_idx" ON "price_quote"("vendor_id");

-- CreateIndex
CREATE INDEX "audit_log_occurred_at_idx" ON "audit_log"("occurred_at");

-- CreateIndex
CREATE INDEX "audit_log_actor_id_occurred_at_idx" ON "audit_log"("actor_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_log_entity_id_idx" ON "audit_log"("entity_id");

-- AddForeignKey
ALTER TABLE "item_category" ADD CONSTRAINT "item_category_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "item_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_master" ADD CONSTRAINT "inventory_master_category_fkey" FOREIGN KEY ("category") REFERENCES "item_category"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_master" ADD CONSTRAINT "inventory_master_preferred_vendor_id_fkey" FOREIGN KEY ("preferred_vendor_id") REFERENCES "vendor_master"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendor_master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_item" ADD CONSTRAINT "purchase_order_item_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "purchase_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_item" ADD CONSTRAINT "purchase_order_item_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_inward_ledger" ADD CONSTRAINT "purchase_inward_ledger_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_inward_ledger" ADD CONSTRAINT "purchase_inward_ledger_purchase_order_item_id_fkey" FOREIGN KEY ("purchase_order_item_id") REFERENCES "purchase_order_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_inward_ledger" ADD CONSTRAINT "purchase_inward_ledger_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_inward_ledger" ADD CONSTRAINT "purchase_inward_ledger_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendor_master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_inward_ledger" ADD CONSTRAINT "purchase_inward_ledger_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "stock_transaction_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_batch" ADD CONSTRAINT "stock_batch_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_batch" ADD CONSTRAINT "stock_batch_inward_id_fkey" FOREIGN KEY ("inward_id") REFERENCES "purchase_inward_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "central_stock" ADD CONSTRAINT "central_stock_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_master"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outlet_stock" ADD CONSTRAINT "outlet_stock_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_master"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outlet_stock" ADD CONSTRAINT "outlet_stock_outlet_department_id_fkey" FOREIGN KEY ("outlet_department_id") REFERENCES "outlet_master"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisition" ADD CONSTRAINT "requisition_outlet_department_id_fkey" FOREIGN KEY ("outlet_department_id") REFERENCES "outlet_master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisition_item" ADD CONSTRAINT "requisition_item_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "requisition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requisition_item" ADD CONSTRAINT "requisition_item_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_requisition_ledger" ADD CONSTRAINT "issue_requisition_ledger_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "requisition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_requisition_ledger" ADD CONSTRAINT "issue_requisition_ledger_requisition_item_id_fkey" FOREIGN KEY ("requisition_item_id") REFERENCES "requisition_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_requisition_ledger" ADD CONSTRAINT "issue_requisition_ledger_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_requisition_ledger" ADD CONSTRAINT "issue_requisition_ledger_outlet_department_id_fkey" FOREIGN KEY ("outlet_department_id") REFERENCES "outlet_master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_requisition_ledger" ADD CONSTRAINT "issue_requisition_ledger_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "stock_transaction_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transaction_ledger" ADD CONSTRAINT "stock_transaction_ledger_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closing_stock_daily_valuation" ADD CONSTRAINT "closing_stock_daily_valuation_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outlet_revenue_daily" ADD CONSTRAINT "outlet_revenue_daily_outlet_department_id_fkey" FOREIGN KEY ("outlet_department_id") REFERENCES "outlet_master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_quote" ADD CONSTRAINT "price_quote_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_master"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_quote" ADD CONSTRAINT "price_quote_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendor_master"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── CHECK constraints ─────────────────────────────────────────────────────
ALTER TABLE central_stock ADD CONSTRAINT central_stock_quantity_check CHECK ((quantity_on_hand >= (0)::numeric));
ALTER TABLE closing_stock_daily_valuation ADD CONSTRAINT closing_stock_daily_valuation_closing_check CHECK ((closing_qty >= (0)::numeric));
ALTER TABLE inventory_master ADD CONSTRAINT inventory_master_levels_check CHECK (((min_stock_level >= (0)::numeric) AND (reorder_point >= (0)::numeric) AND (max_stock_level >= (0)::numeric) AND (order_multiple > (0)::numeric)));
ALTER TABLE inventory_master ADD CONSTRAINT inventory_master_shelf_life_check CHECK (((shelf_life_days IS NULL) OR (shelf_life_days > 0)));
ALTER TABLE issue_requisition_ledger ADD CONSTRAINT issue_requisition_ledger_quantity_check CHECK (((quantity_issued > (0)::numeric) AND (quantity_issued <= quantity_requested)));
ALTER TABLE item_category ADD CONSTRAINT item_category_level_check CHECK (((level >= 1) AND (level <= 3)));
ALTER TABLE item_category ADD CONSTRAINT item_category_shelf_life_check CHECK (((default_shelf_life_days IS NULL) OR (default_shelf_life_days > 0)));
ALTER TABLE outlet_revenue_daily ADD CONSTRAINT outlet_revenue_daily_revenue_check CHECK ((revenue >= (0)::numeric));
ALTER TABLE outlet_stock ADD CONSTRAINT outlet_stock_quantity_check CHECK ((quantity_on_hand >= (0)::numeric));
ALTER TABLE purchase_inward_ledger ADD CONSTRAINT purchase_inward_ledger_dates_check CHECK (((expiry_date IS NULL) OR (manufacture_date IS NULL) OR (expiry_date >= manufacture_date)));
ALTER TABLE purchase_inward_ledger ADD CONSTRAINT purchase_inward_ledger_quantity_check CHECK (((quantity_received >= (0)::numeric) AND (quantity_rejected >= (0)::numeric) AND ((quantity_received + quantity_rejected) > (0)::numeric)));
ALTER TABLE purchase_inward_ledger ADD CONSTRAINT purchase_inward_ledger_stock_link_check CHECK (((quantity_received > (0)::numeric) = (transaction_id IS NOT NULL)));
ALTER TABLE purchase_order_item ADD CONSTRAINT purchase_order_item_quantity_check CHECK (((quantity_ordered > (0)::numeric) AND (quantity_received >= (0)::numeric) AND (quantity_rejected >= (0)::numeric) AND ((quantity_received + quantity_rejected) <= quantity_ordered)));
ALTER TABLE requisition_item ADD CONSTRAINT requisition_item_quantity_check CHECK (((quantity_requested > (0)::numeric) AND (quantity_issued >= (0)::numeric) AND (quantity_issued <= quantity_requested)));
ALTER TABLE stock_batch ADD CONSTRAINT stock_batch_quantity_check CHECK (((quantity_remaining >= (0)::numeric) AND (quantity_remaining <= quantity_received)));

-- ─── Append-only ledgers ───────────────────────────────────────────────────
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

-- ─── Reference data: item category tree ────────────────────────────────────
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
