-- Phase 6: căn chỉnh vận chuyển/vận đơn theo Sapo Admin API.
-- Bảng `fulfillments` đang RỖNG (0 dòng) nên swap kiểu enum không cần backfill.

-- =====================================================================
-- 1) ENUM: đổi sang bộ giá trị của Sapo
-- =====================================================================
CREATE TYPE "PackingStatus_new" AS ENUM ('unknown', 'packing', 'packed');
CREATE TYPE "ShipmentStatus_new" AS ENUM (
  'pending', 'picked_up', 'delivering', 'delivered',
  'retry_delivery', 'returning', 'returned', 'cancelled'
);

ALTER TABLE "fulfillments" ALTER COLUMN "packing_status" DROP DEFAULT;
ALTER TABLE "fulfillments" ALTER COLUMN "shipment_status" DROP DEFAULT;
ALTER TABLE "fulfillments"
  ALTER COLUMN "packing_status" TYPE "PackingStatus_new" USING NULL,
  ALTER COLUMN "shipment_status" TYPE "ShipmentStatus_new" USING NULL;

DROP TYPE "PackingStatus";
DROP TYPE "ShipmentStatus";
ALTER TYPE "PackingStatus_new" RENAME TO "PackingStatus";
ALTER TYPE "ShipmentStatus_new" RENAME TO "ShipmentStatus";

CREATE TYPE "FulfillmentDeliveryMethod" AS ENUM (
  'external_service', 'ecommerce', 'pick_up', 'external_shipper', 'outside_shipper'
);
CREATE TYPE "ShipmentCategory" AS ENUM ('fast', 'other');
CREATE TYPE "PackageCategory" AS ENUM (
  'single_item_quantity', 'single_item_multiple_quantity', 'multiple_items'
);

-- =====================================================================
-- 2) FULFILLMENTS: đổi tên cột theo Sapo
-- =====================================================================
ALTER TABLE "fulfillments" RENAME COLUMN "code" TO "name";
ALTER TABLE "fulfillments" RENAME COLUMN "packing_status" TO "packed_status";
ALTER TABLE "fulfillments" RENAME COLUMN "packer_id" TO "assigned_packer_id";
ALTER TABLE "fulfillments" RENAME COLUMN "packed_at" TO "packed_on";
ALTER TABLE "fulfillments" RENAME COLUMN "tracking_code" TO "tracking_number";
ALTER TABLE "fulfillments" RENAME COLUMN "pushed_at" TO "shipment_created_on";
ALTER TABLE "fulfillments" RENAME COLUMN "delivered_at" TO "delivered_on";
ALTER TABLE "fulfillments" RENAME COLUMN "cancelled_at" TO "cancelled_on";
ALTER TABLE "fulfillments" RENAME COLUMN "created_at" TO "created_on";
ALTER TABLE "fulfillments" RENAME COLUMN "updated_at" TO "modified_on";
-- Địa chỉ lấy hàng: from_* -> origin_* (Sapo `origin_address`)
ALTER TABLE "fulfillments" RENAME COLUMN "from_name" TO "origin_name";
ALTER TABLE "fulfillments" RENAME COLUMN "from_phone" TO "origin_phone";
ALTER TABLE "fulfillments" RENAME COLUMN "from_address" TO "origin_address1";

-- =====================================================================
-- 3) FULFILLMENTS: thêm cột Sapo còn thiếu
-- =====================================================================
ALTER TABLE "fulfillments" ADD COLUMN "sapo_id" BIGINT;
ALTER TABLE "fulfillments" ADD COLUMN "store_id" BIGINT;
ALTER TABLE "fulfillments" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'success';
ALTER TABLE "fulfillments" ADD COLUMN "delivery_method" "FulfillmentDeliveryMethod";
ALTER TABLE "fulfillments" ADD COLUMN "shipment_category" "ShipmentCategory";
ALTER TABLE "fulfillments" ADD COLUMN "package_category" "PackageCategory";
ALTER TABLE "fulfillments" ADD COLUMN "tracking_url" TEXT;
ALTER TABLE "fulfillments" ADD COLUMN "tracking_company" TEXT;
ALTER TABLE "fulfillments" ADD COLUMN "carrier" TEXT;
ALTER TABLE "fulfillments" ADD COLUMN "carrier_name" TEXT;
ALTER TABLE "fulfillments" ADD COLUMN "tracking_numbers" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "fulfillments" ADD COLUMN "tracking_urls" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "fulfillments" ADD COLUMN "shipping_label_slip_url" TEXT;
ALTER TABLE "fulfillments" ADD COLUMN "shipping_label_slip_error" TEXT;
ALTER TABLE "fulfillments" ADD COLUMN "notify_customer" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "fulfillments" ADD COLUMN "total_quantity" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "fulfillments" ADD COLUMN "sla" JSONB;
ALTER TABLE "fulfillments" ADD COLUMN "abnormal" JSONB;
ALTER TABLE "fulfillments" ADD COLUMN "picking_issues" JSONB;
ALTER TABLE "fulfillments" ADD COLUMN "origin_email" TEXT;
ALTER TABLE "fulfillments" ADD COLUMN "origin_address2" TEXT;
ALTER TABLE "fulfillments" ADD COLUMN "origin_ward" TEXT;
ALTER TABLE "fulfillments" ADD COLUMN "origin_ward_code" TEXT;
ALTER TABLE "fulfillments" ADD COLUMN "origin_district" TEXT;
ALTER TABLE "fulfillments" ADD COLUMN "origin_district_code" TEXT;
ALTER TABLE "fulfillments" ADD COLUMN "origin_province" TEXT;
ALTER TABLE "fulfillments" ADD COLUMN "origin_province_code" TEXT;
ALTER TABLE "fulfillments" ADD COLUMN "origin_city" TEXT;
ALTER TABLE "fulfillments" ADD COLUMN "origin_country" TEXT;
ALTER TABLE "fulfillments" ADD COLUMN "origin_country_code" TEXT;
ALTER TABLE "fulfillments" ADD COLUMN "origin_zip_code" TEXT;
ALTER TABLE "fulfillments" ADD COLUMN "picked_on" TIMESTAMP(3);
ALTER TABLE "fulfillments" ADD COLUMN "picked_user_id" BIGINT;
ALTER TABLE "fulfillments" ADD COLUMN "sorted_on" TIMESTAMP(3);
ALTER TABLE "fulfillments" ADD COLUMN "sorted_user_id" BIGINT;
ALTER TABLE "fulfillments" ADD COLUMN "inspected_on" TIMESTAMP(3);
ALTER TABLE "fulfillments" ADD COLUMN "issued_on" TIMESTAMP(3);
ALTER TABLE "fulfillments" ADD COLUMN "issued_by" TEXT;
ALTER TABLE "fulfillments" ADD COLUMN "issued_user_id" BIGINT;
ALTER TABLE "fulfillments" ADD COLUMN "issued_client_id" BIGINT;
ALTER TABLE "fulfillments" ADD COLUMN "handed_over_at" TIMESTAMP(3);
ALTER TABLE "fulfillments" ADD COLUMN "handed_by" TEXT;
ALTER TABLE "fulfillments" ADD COLUMN "handed_user_id" BIGINT;
ALTER TABLE "fulfillments" ADD COLUMN "expected_delivery_date" TIMESTAMP(3);
ALTER TABLE "fulfillments" ADD COLUMN "order_ship_deadline" TIMESTAMP(3);

CREATE UNIQUE INDEX "fulfillments_sapo_id_key" ON "fulfillments"("sapo_id");

-- =====================================================================
-- 4) BẢNG MỚI: fulfillment_line_items (Sapo `fulfillment.line_items`)
-- =====================================================================
CREATE TABLE "fulfillment_line_items" (
  "id"                       BIGSERIAL PRIMARY KEY,
  "fulfillment_id"           BIGINT NOT NULL,
  "order_item_id"            BIGINT,
  "variant_id"               BIGINT NOT NULL,
  "product_id"               BIGINT,
  "name"                     TEXT NOT NULL,
  "title"                    TEXT,
  "variant_title"            TEXT,
  "sku"                      TEXT NOT NULL,
  "quantity"                 INTEGER NOT NULL,
  "effective_quantity"       INTEGER,
  "fulfillable_quantity"     INTEGER,
  "non_fulfillable_quantity" INTEGER,
  "refundable_quantity"      INTEGER,
  "price"                    DECIMAL(18,2) NOT NULL,
  "total_discount"           DECIMAL(18,2) NOT NULL DEFAULT 0,
  "discounted_total"         DECIMAL(18,2) NOT NULL,
  "original_total"           DECIMAL(18,2),
  "grams"                    INTEGER,
  "taxable"                  BOOLEAN NOT NULL DEFAULT true,
  "requires_shipping"        BOOLEAN NOT NULL DEFAULT true,
  "restockable"              BOOLEAN NOT NULL DEFAULT true,
  "fulfillment_status"       TEXT,
  CONSTRAINT "fulfillment_line_items_fulfillment_id_fkey"
    FOREIGN KEY ("fulfillment_id") REFERENCES "fulfillments"("id") ON DELETE CASCADE,
  CONSTRAINT "fulfillment_line_items_variant_id_fkey"
    FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id")
);
CREATE INDEX "fulfillment_line_items_fulfillment_id_idx" ON "fulfillment_line_items"("fulfillment_id");
CREATE INDEX "fulfillment_line_items_variant_id_idx" ON "fulfillment_line_items"("variant_id");

-- =====================================================================
-- 5) BẢNG MỚI: order_shipping_lines (Sapo `order.shipping_lines`)
-- =====================================================================
CREATE TABLE "order_shipping_lines" (
  "id"                   BIGSERIAL PRIMARY KEY,
  "order_id"             BIGINT NOT NULL,
  "title"                TEXT,
  "code"                 TEXT,
  "source"               TEXT,
  "price"                DECIMAL(18,2) NOT NULL DEFAULT 0,
  "carrier"              TEXT,
  "carrier_name"         TEXT,
  "discount_allocations" JSONB,
  "tax_lines"            JSONB,
  CONSTRAINT "order_shipping_lines_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE
);
CREATE INDEX "order_shipping_lines_order_id_idx" ON "order_shipping_lines"("order_id");
