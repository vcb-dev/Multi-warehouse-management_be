-- Phase 8: tách "hoàn tiền" khỏi "trả hàng" theo đúng mô hình Sapo.
--
-- Sapo dùng `order.refunds[]` làm bản ghi tiền cho CẢ hai luồng:
--   - trả hàng  -> refund.return_id khác null, refund_line_item.restock_type = return/no_restock
--   - huỷ đơn   -> refund.return_id = null,    refund_line_item.restock_type = cancel
-- Sapo vẫn tạo refund kể cả khi total_refunded = 0 (trả hàng không hoàn tiền).
--
-- `order_returns`/`order_return_items` đang RỖNG (0 dòng) nên tái cấu trúc không mất dữ liệu.

-- 1) Enum mới
CREATE TYPE "RestockType" AS ENUM ('cancel', 'return_item', 'no_restock');
CREATE TYPE "OrderRestockStatus" AS ENUM ('no_restock', 'restocked', 'partial');

-- 2) orders.restock_status: text -> enum (dữ liệu Sapo đã dùng đúng 3 giá trị này)
ALTER TABLE "orders"
  ALTER COLUMN "restock_status" TYPE "OrderRestockStatus"
  USING NULLIF("restock_status", '')::"OrderRestockStatus";

-- 3) order_returns: bỏ phần tiền/nhập kho (chuyển sang order_refunds), thêm sapo_id
DROP TABLE IF EXISTS "order_return_items";
ALTER TABLE "order_returns" DROP COLUMN "refund_amount";
ALTER TABLE "order_returns" DROP COLUMN "restock";
ALTER TABLE "order_returns" RENAME COLUMN "created_at" TO "created_on";
ALTER TABLE "order_returns" ADD COLUMN "sapo_id" BIGINT;
CREATE UNIQUE INDEX "order_returns_sapo_id_key" ON "order_returns"("sapo_id");
DROP INDEX IF EXISTS "order_returns_created_at_idx";
CREATE INDEX "order_returns_created_on_idx" ON "order_returns"("created_on");

-- 4) order_refunds (Sapo `order.refunds[]`)
CREATE TABLE "order_refunds" (
  "id"             BIGSERIAL PRIMARY KEY,
  "sapo_id"        BIGINT,
  "order_id"       BIGINT NOT NULL,
  "return_id"      BIGINT,
  "note"           TEXT,
  "restock"        BOOLEAN NOT NULL DEFAULT false,
  "total_refunded" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "processed_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "user_id"        BIGINT NOT NULL,
  "created_on"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_refunds_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE,
  CONSTRAINT "order_refunds_return_id_fkey"
    FOREIGN KEY ("return_id") REFERENCES "order_returns"("id"),
  CONSTRAINT "order_refunds_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
);
CREATE UNIQUE INDEX "order_refunds_sapo_id_key" ON "order_refunds"("sapo_id");
CREATE INDEX "order_refunds_order_id_idx" ON "order_refunds"("order_id");
CREATE INDEX "order_refunds_return_id_idx" ON "order_refunds"("return_id");

-- 5) order_refund_items (Sapo `refund.refund_line_items[]`)
CREATE TABLE "order_refund_items" (
  "id"            BIGSERIAL PRIMARY KEY,
  "sapo_id"       BIGINT,
  "refund_id"     BIGINT NOT NULL,
  "order_item_id" BIGINT,
  "variant_id"    BIGINT NOT NULL,
  "location_id"   BIGINT NOT NULL,
  "product_name"  TEXT NOT NULL,
  "sku"           TEXT NOT NULL,
  "variant_title" TEXT,
  "quantity"      INTEGER NOT NULL,
  "price"         DECIMAL(18,2) NOT NULL,
  "subtotal"      DECIMAL(18,2) NOT NULL DEFAULT 0,
  "total_tax"     DECIMAL(18,2) NOT NULL DEFAULT 0,
  "restock_type"  "RestockType" NOT NULL,
  CONSTRAINT "order_refund_items_refund_id_fkey"
    FOREIGN KEY ("refund_id") REFERENCES "order_refunds"("id") ON DELETE CASCADE,
  CONSTRAINT "order_refund_items_variant_id_fkey"
    FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id"),
  CONSTRAINT "order_refund_items_location_id_fkey"
    FOREIGN KEY ("location_id") REFERENCES "locations"("id")
);
CREATE UNIQUE INDEX "order_refund_items_sapo_id_key" ON "order_refund_items"("sapo_id");
CREATE INDEX "order_refund_items_refund_id_idx" ON "order_refund_items"("refund_id");
CREATE INDEX "order_refund_items_variant_id_idx" ON "order_refund_items"("variant_id");
CREATE INDEX "order_refund_items_location_id_idx" ON "order_refund_items"("location_id");
