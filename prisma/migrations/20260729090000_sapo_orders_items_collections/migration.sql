-- Phase 5: căn chỉnh nốt orders / order_items / categories theo Sapo Admin API.
-- Chỉ đổi tên + thêm cột, KHÔNG đổi giá trị nghiệp vụ (trừ việc bỏ tiền tố
-- "SAPO-" khỏi mã đơn để dùng đúng mã Sapo trả về).

-- =====================================================================
-- 1) ORDERS
-- =====================================================================

-- 1.1 code -> name, bỏ tiền tố SAPO- (đã kiểm chứng: 0 va chạm, 0 trùng)
ALTER TABLE "orders" RENAME COLUMN "code" TO "name";
UPDATE "orders" SET "name" = substring("name" from 6) WHERE "name" LIKE 'SAPO-%';

-- 1.2 Số thứ tự đơn của Sapo (chỉ đơn đồng bộ mới có, backfill sau qua API)
ALTER TABLE "orders" ADD COLUMN "number" INTEGER;
ALTER TABLE "orders" ADD COLUMN "order_number" INTEGER;

-- 1.3 Người dùng
ALTER TABLE "orders" RENAME COLUMN "assigned_to" TO "assignee_id";
ALTER TABLE "orders" RENAME COLUMN "created_by" TO "user_id";

-- 1.4 Tiền tệ
ALTER TABLE "orders" RENAME COLUMN "subtotal" TO "sub_total_price";
ALTER TABLE "orders" RENAME COLUMN "discount_total" TO "total_discounts";
ALTER TABLE "orders" RENAME COLUMN "tax_total" TO "total_tax";
ALTER TABLE "orders" RENAME COLUMN "shipping_fee" TO "total_shipping_price";
ALTER TABLE "orders" RENAME COLUMN "total_amount" TO "total_price";
ALTER TABLE "orders" RENAME COLUMN "total_quantity" TO "subtotal_line_items_quantity";
ALTER TABLE "orders" RENAME COLUMN "paid_amount" TO "total_received";

ALTER TABLE "orders" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'VND';
ALTER TABLE "orders" ADD COLUMN "gateway" TEXT;
ALTER TABLE "orders" ADD COLUMN "total_weight" INTEGER;
ALTER TABLE "orders" ADD COLUMN "net_payment" DECIMAL(18,2);
ALTER TABLE "orders" ADD COLUMN "unpaid_amount" DECIMAL(18,2);
ALTER TABLE "orders" ADD COLUMN "total_outstanding" DECIMAL(18,2);
ALTER TABLE "orders" ADD COLUMN "total_refunded" DECIMAL(18,2);

-- 1.5 Mốc thời gian.
-- `created_at` cũ chỉ là lúc ghi vào DB này (đã kiểm chứng: lệch với ordered_at
-- ở 87.912/87.938 dòng, đúng bằng thời điểm sync) → bỏ hẳn.
-- `ordered_at` mới là ngày đặt hàng thật của Sapo → đổi thành `created_on`.
ALTER TABLE "orders" DROP COLUMN "created_at";
ALTER TABLE "orders" RENAME COLUMN "ordered_at" TO "created_on";
ALTER TABLE "orders" RENAME COLUMN "updated_at" TO "modified_on";
ALTER TABLE "orders" RENAME COLUMN "expected_delivery_at" TO "expected_delivery_date";
-- shipped_at có thể thiếu trên DB drift (migration add đã ghi applied nhưng cột không còn).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'shipped_at'
  ) THEN
    EXECUTE 'ALTER TABLE "orders" RENAME COLUMN "shipped_at" TO "delivered_on"';
  ELSIF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'delivered_on'
  ) THEN
    EXECUTE 'ALTER TABLE "orders" ADD COLUMN "delivered_on" TIMESTAMP(3)';
  END IF;
END $$;
ALTER TABLE "orders" ADD COLUMN "processed_on" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "settled_on" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "issued_on" TIMESTAMP(3);

-- 1.6 Địa chỉ giao hàng: delivery_to_* -> shipping_* (theo object shipping_address)
ALTER TABLE "orders" RENAME COLUMN "delivery_to_name" TO "shipping_name";
ALTER TABLE "orders" RENAME COLUMN "delivery_to_phone" TO "shipping_phone";
ALTER TABLE "orders" RENAME COLUMN "delivery_to_address" TO "shipping_address1";
ALTER TABLE "orders" RENAME COLUMN "delivery_to_ward" TO "shipping_ward";
ALTER TABLE "orders" RENAME COLUMN "delivery_to_district" TO "shipping_district";
ALTER TABLE "orders" RENAME COLUMN "delivery_to_province" TO "shipping_province";

ALTER TABLE "orders" ADD COLUMN "shipping_first_name" TEXT;
ALTER TABLE "orders" ADD COLUMN "shipping_last_name" TEXT;
ALTER TABLE "orders" ADD COLUMN "shipping_address2" TEXT;
ALTER TABLE "orders" ADD COLUMN "shipping_ward_code" TEXT;
ALTER TABLE "orders" ADD COLUMN "shipping_district_code" TEXT;
ALTER TABLE "orders" ADD COLUMN "shipping_province_code" TEXT;
ALTER TABLE "orders" ADD COLUMN "shipping_city" TEXT;
ALTER TABLE "orders" ADD COLUMN "shipping_country" TEXT;
ALTER TABLE "orders" ADD COLUMN "shipping_country_code" TEXT;
ALTER TABLE "orders" ADD COLUMN "shipping_zip" TEXT;
ALTER TABLE "orders" ADD COLUMN "shipping_company" TEXT;
ALTER TABLE "orders" ADD COLUMN "shipping_latitude" DECIMAL(10,7);
ALTER TABLE "orders" ADD COLUMN "shipping_longitude" DECIMAL(10,7);

-- 1.7 Địa chỉ xuất hóa đơn (Sapo `billing_address`)
ALTER TABLE "orders" ADD COLUMN "billing_name" TEXT;
ALTER TABLE "orders" ADD COLUMN "billing_phone" TEXT;
ALTER TABLE "orders" ADD COLUMN "billing_address1" TEXT;
ALTER TABLE "orders" ADD COLUMN "billing_ward" TEXT;
ALTER TABLE "orders" ADD COLUMN "billing_district" TEXT;
ALTER TABLE "orders" ADD COLUMN "billing_province" TEXT;
ALTER TABLE "orders" ADD COLUMN "billing_country" TEXT;
ALTER TABLE "orders" ADD COLUMN "billing_zip" TEXT;

-- 1.8 Index theo cột đã đổi tên
DROP INDEX IF EXISTS "orders_location_id_status_ordered_at_idx";
DROP INDEX IF EXISTS "orders_ordered_at_idx";
CREATE INDEX "orders_location_id_status_created_on_idx" ON "orders"("location_id", "status", "created_on");
CREATE INDEX "orders_created_on_idx" ON "orders"("created_on");

-- =====================================================================
-- 2) ORDER_ITEMS  (Sapo `line_items`)
-- =====================================================================

ALTER TABLE "order_items" RENAME COLUMN "product_name" TO "name";
ALTER TABLE "order_items" RENAME COLUMN "discount" TO "total_discount";
ALTER TABLE "order_items" RENAME COLUMN "total" TO "discounted_total";

ALTER TABLE "order_items" ADD COLUMN "product_id" BIGINT;
ALTER TABLE "order_items" ADD COLUMN "inventory_item_id" BIGINT;
ALTER TABLE "order_items" ADD COLUMN "variant_title" TEXT;
ALTER TABLE "order_items" ADD COLUMN "original_total" DECIMAL(18,2);
ALTER TABLE "order_items" ADD COLUMN "fulfillable_quantity" INTEGER;
ALTER TABLE "order_items" ADD COLUMN "current_quantity" INTEGER;
ALTER TABLE "order_items" ADD COLUMN "non_fulfillable_quantity" INTEGER;
ALTER TABLE "order_items" ADD COLUMN "refundable_quantity" INTEGER;
ALTER TABLE "order_items" ADD COLUMN "grams" INTEGER;
ALTER TABLE "order_items" ADD COLUMN "taxable" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "order_items" ADD COLUMN "requires_shipping" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "order_items" ADD COLUMN "restockable" BOOLEAN NOT NULL DEFAULT true;

-- original_total = giá gốc trước giảm (Sapo). Backfill từ dữ liệu sẵn có.
UPDATE "order_items" SET "original_total" = "price" * "quantity";

-- Lấy product_id / inventory_item_id / variant_title từ variant đã đồng bộ
UPDATE "order_items" oi
SET "product_id" = pv."product_id",
    "inventory_item_id" = pv."inventory_item_id",
    "variant_title" = pv."title"
FROM "product_variants" pv
WHERE pv."id" = oi."variant_id";

-- =====================================================================
-- 3) CATEGORIES  (Sapo `custom_collections`)
-- =====================================================================

ALTER TABLE "categories" RENAME COLUMN "slug" TO "alias";
ALTER TABLE "categories" RENAME COLUMN "created_at" TO "created_on";
ALTER TABLE "categories" RENAME COLUMN "updated_at" TO "modified_on";

ALTER TABLE "categories" ADD COLUMN "meta_title" TEXT;
ALTER TABLE "categories" ADD COLUMN "meta_description" TEXT;
ALTER TABLE "categories" ADD COLUMN "template_layout" TEXT;
ALTER TABLE "categories" ADD COLUMN "sort_order" TEXT;
ALTER TABLE "categories" ADD COLUMN "published_on" TIMESTAMP(3);
ALTER TABLE "categories" ADD COLUMN "products_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "categories" ADD COLUMN "image_src" TEXT;
ALTER TABLE "categories" ADD COLUMN "image_alt" TEXT;
ALTER TABLE "categories" ADD COLUMN "image_width" INTEGER;
ALTER TABLE "categories" ADD COLUMN "image_height" INTEGER;
ALTER TABLE "categories" ADD COLUMN "rules" JSONB;
ALTER TABLE "categories" ADD COLUMN "disjunctive" BOOLEAN NOT NULL DEFAULT false;

-- image_url cũ = Sapo image.src
UPDATE "categories" SET "image_src" = "image_url" WHERE "image_url" IS NOT NULL;
ALTER TABLE "categories" DROP COLUMN "image_url";

-- auto_conditions (định dạng riêng) -> rules (định dạng Sapo)
UPDATE "categories" SET "rules" = "auto_conditions" WHERE "auto_conditions" IS NOT NULL;
ALTER TABLE "categories" DROP COLUMN "auto_conditions";

-- products_count: đếm thật từ bảng nối
UPDATE "categories" c
SET "products_count" = COALESCE(t.n, 0)
FROM (SELECT "category_id", count(*)::int AS n FROM "product_categories" GROUP BY 1) t
WHERE t."category_id" = c."id";

-- =====================================================================
-- 4) PRODUCT_CATEGORIES  (Sapo `collects`)
-- =====================================================================

ALTER TABLE "product_categories" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "product_categories" ADD COLUMN "featured" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "product_categories" ADD COLUMN "created_on" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "product_categories" ADD COLUMN "modified_on" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
