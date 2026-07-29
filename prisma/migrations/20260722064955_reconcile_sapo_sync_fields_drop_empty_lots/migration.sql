-- Đối soát lịch sử migration với DB thật (Supabase, shared với hệ đồng bộ Sapo).
-- Các cột sapo_id/category/... dưới đây đã tồn tại thật trong DB từ trước —
-- schema.prisma trước đó bị thiếu khai báo (drift), không phải cột mới.
-- Toàn bộ ADD COLUMN/CREATE INDEX dùng IF NOT EXISTS nên vô hại nếu chạy lại.
--
-- Duy nhất phần thực sự thay đổi DB: DROP TABLE "lots" — bảng đang rỗng (0 dòng),
-- đúng ý định ban đầu của migration 20260717133500_remove_lot_tracking (migration
-- đó đã DROP TABLE "lots" nhưng bảng bị khôi phục lại từ backup sau đó mà không
-- cập nhật lại schema/migration history).

-- AlterEnum
ALTER TYPE "OrderSource" ADD VALUE IF NOT EXISTS 'sapo';

-- AlterTable: products
ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "sapo_id" BIGINT,
  ADD COLUMN IF NOT EXISTS "category" TEXT,
  ADD COLUMN IF NOT EXISTS "material" TEXT,
  ADD COLUMN IF NOT EXISTS "craft_type" TEXT,
  ADD COLUMN IF NOT EXISTS "is_discontinued" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "published_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "sapo_created_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "sapo_updated_at" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "products_sapo_id_key" ON "products"("sapo_id");

-- AlterTable: product_variants
ALTER TABLE "product_variants"
  ADD COLUMN IF NOT EXISTS "sapo_id" BIGINT,
  ADD COLUMN IF NOT EXISTS "title" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "product_variants_sapo_id_key" ON "product_variants"("sapo_id");

-- AlterTable: orders
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "sapo_id" BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS "orders_sapo_id_key" ON "orders"("sapo_id");

-- AlterTable: customers
ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "sapo_id" BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS "customers_sapo_id_key" ON "customers"("sapo_id");
CREATE INDEX IF NOT EXISTS "customers_email_idx" ON "customers"("email");

-- AlterTable: categories
ALTER TABLE "categories"
  ADD COLUMN IF NOT EXISTS "sapo_id" BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS "categories_sapo_id_key" ON "categories"("sapo_id");

-- DropTable (bảng rỗng, xác nhận 0 dòng trước khi drop)
-- CASCADE: chỉ xóa các FK constraint rỗng (lot_id ở goods_receipt_items,
-- inventory_movements, purchase_return_items, stock_transfer_items đều 100% NULL
-- trên DB production — đã xác nhận trước khi thêm CASCADE), không xóa cột/dữ liệu.
DROP TABLE IF EXISTS "lots" CASCADE;
