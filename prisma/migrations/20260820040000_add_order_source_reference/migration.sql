-- "Mã tham chiếu" của đơn sàn: mã đơn bên sàn + link mở đơn gốc + gian hàng.
-- Thêm cột nullable, không đụng dữ liệu cũ; backfill chạy riêng bằng
-- scripts/backfill-order-source-reference.ts.
ALTER TABLE "orders"
  ADD COLUMN "source_identifier" TEXT,
  ADD COLUMN "source_url" TEXT,
  ADD COLUMN "channel_shop_id" TEXT,
  ADD COLUMN "channel_shop_name" TEXT;

-- Tra đơn theo mã bên sàn (dán mã từ Seller Center vào ô tìm kiếm).
CREATE INDEX "orders_source_identifier_idx" ON "orders" ("source_identifier");
