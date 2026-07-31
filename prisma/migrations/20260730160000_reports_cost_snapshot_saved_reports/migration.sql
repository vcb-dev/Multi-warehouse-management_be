-- Module Báo cáo (008) — đợt 1.
--
-- Báo cáo KHÔNG có bảng dữ liệu riêng (theo docs/02-modules/08-bao-cao/du-lieu.md): số liệu
-- tổng hợp trực tiếp từ orders/order_items/inventory_*. Cố ý KHÔNG tạo SQL view /
-- materialized view như docs đề xuất: `orders` đã có sẵn index (location_id, status,
-- created_on) và (created_on) đúng nhu cầu báo cáo; thêm view lúc chưa đo được là phức tạp
-- hoá vô ích.
--
-- Migration này chỉ cần 2 thứ:

-- 1) Chốt giá vốn tại thời điểm bán.
--    `ProductVariant.cost` là giá vốn HIỆN TẠI (đồng bộ từ Sapo InventoryItem.cost_price),
--    nên báo cáo lợi nhuận kỳ cũ sẽ trôi mỗi lần giá vốn đổi. Snapshot vào dòng đơn để số
--    liệu quá khứ đứng yên. NULL với đơn tạo trước tính năng này -> báo cáo fallback
--    COALESCE(oi.cost_price, v.cost).
ALTER TABLE "order_items" ADD COLUMN "cost_price" DECIMAL(18,2);

-- 2) Báo cáo người dùng ghim lên màn tổng quan /bao-cao (FR-004).
CREATE TABLE "saved_reports" (
  "id"         BIGSERIAL NOT NULL,
  "user_id"    BIGINT NOT NULL,
  "report_key" TEXT NOT NULL,
  "filters"    JSONB,
  "is_pinned"  BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Prisma @updatedAt là application-level nên KHÔNG có default; INSERT bằng raw SQL phải
  -- truyền tay (bài học Phase 1 trong docs/sapo-schema-mapping.md).
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "saved_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "saved_reports_user_id_report_key_key"
  ON "saved_reports"("user_id", "report_key");
CREATE INDEX "saved_reports_user_id_is_pinned_idx"
  ON "saved_reports"("user_id", "is_pinned");

ALTER TABLE "saved_reports"
  ADD CONSTRAINT "saved_reports_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
