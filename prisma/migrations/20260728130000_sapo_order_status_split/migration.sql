-- Phase 3 — Tách trạng thái đơn hàng theo Sapo Admin API (5 field độc lập
-- thay cho 1 enum OrderStatus + payment_status cũ). Nguồn: gọi thật
-- /admin/orders.json ngày 2026-07-28. Chi tiết: docs/sapo-schema-mapping.md.
--
-- PaymentStatus KHÔNG đổi — vẫn dùng riêng cho GoodsReceipt (nghiệp vụ nhập
-- hàng, không thuộc mô hình Order của Sapo).

-- 1) Enum mới
CREATE TYPE "OrderFinancialStatus" AS ENUM ('pending','partially_paid','paid','refunded','partially_refunded');
CREATE TYPE "OrderFulfillmentStatus" AS ENUM ('partial','fulfilled');
CREATE TYPE "OrderReturnStatus" AS ENUM ('no_return','in_progress','returned');
CREATE TYPE "OrderRefundStatus" AS ENUM ('no_refund','refunded','partial');

-- 2) OrderStatus: đổi hẳn tập giá trị theo Sapo.
--    ordered/processing -> open (phân biệt bằng confirmed_on ở bước sau)
--    completed/returned  -> closed (return tách hẳn sang return_status)
--    cancelled           -> cancelled
CREATE TYPE "OrderStatus_new" AS ENUM ('open','closed','cancelled');
ALTER TABLE "orders" ADD COLUMN "status_new" "OrderStatus_new";
UPDATE "orders" SET "status_new" = (CASE
  WHEN "status" = 'cancelled' THEN 'cancelled'
  WHEN "status" IN ('completed', 'returned') THEN 'closed'
  ELSE 'open'
END)::"OrderStatus_new";
ALTER TABLE "orders" ALTER COLUMN "status_new" SET NOT NULL;
ALTER TABLE "orders" ALTER COLUMN "status_new" SET DEFAULT 'open';
DROP INDEX "orders_location_id_status_ordered_at_idx";
ALTER TABLE "orders" DROP COLUMN "status";
ALTER TABLE "orders" RENAME COLUMN "status_new" TO "status";
DROP TYPE "OrderStatus";
ALTER TYPE "OrderStatus_new" RENAME TO "OrderStatus";
CREATE INDEX "orders_location_id_status_ordered_at_idx" ON "orders"("location_id", "status", "ordered_at");

-- 3) financial_status thay cho payment_status (giá trị cũ chỉ có 3/5 mức của Sapo)
ALTER TABLE "orders" ADD COLUMN "financial_status" "OrderFinancialStatus";
UPDATE "orders" SET "financial_status" = (CASE "payment_status"
  WHEN 'da_thanh_toan' THEN 'paid'
  WHEN 'mot_phan' THEN 'partially_paid'
  ELSE 'pending'
END)::"OrderFinancialStatus";
ALTER TABLE "orders" ALTER COLUMN "financial_status" SET NOT NULL;
ALTER TABLE "orders" ALTER COLUMN "financial_status" SET DEFAULT 'pending';
ALTER TABLE "orders" DROP COLUMN "payment_status";

-- 4) fulfillment_status / return_status / refund_status / issue_status / restock_status
ALTER TABLE "orders" ADD COLUMN "fulfillment_status" "OrderFulfillmentStatus";
ALTER TABLE "orders" ADD COLUMN "return_status" "OrderReturnStatus" NOT NULL DEFAULT 'no_return';
ALTER TABLE "orders" ADD COLUMN "refund_status" "OrderRefundStatus" NOT NULL DEFAULT 'no_refund';
ALTER TABLE "orders" ADD COLUMN "issue_status" TEXT;
ALTER TABLE "orders" ADD COLUMN "restock_status" TEXT;

-- 5) Mốc thời gian mới + lý do hủy — backfill tạm từ dữ liệu sẵn có, sẽ ghi đè
--    bằng giá trị thật từ Sapo API ngay sau migration này.
ALTER TABLE "orders" ADD COLUMN "cancel_reason" TEXT;
ALTER TABLE "orders" ADD COLUMN "cancelled_on" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "closed_on" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "confirmed_on" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "completed_on" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "paid_on" TIMESTAMP(3);

UPDATE "orders" SET
  "cancelled_on" = CASE WHEN "status" = 'cancelled' THEN "updated_at" ELSE NULL END,
  "closed_on" = CASE WHEN "status" = 'closed' THEN "updated_at" ELSE NULL END,
  "completed_on" = CASE WHEN "status" = 'closed' THEN COALESCE("shipped_at", "updated_at") ELSE NULL END,
  "confirmed_on" = CASE WHEN "status" <> 'cancelled' THEN "ordered_at" ELSE NULL END,
  "fulfillment_status" = CASE WHEN "shipped_at" IS NOT NULL THEN 'fulfilled'::"OrderFulfillmentStatus" ELSE NULL END,
  "paid_on" = CASE WHEN "financial_status" = 'paid' THEN "updated_at" ELSE NULL END;

-- 6) source (enum) -> source_name (chuỗi tự do, khớp Sapo — kênh bán liên tục
--    có thêm giá trị mới nên không hợp để làm Postgres enum cố định).
--    Giá trị thật (facebook/tiktokshop/shopee/...) backfill ngay sau migration —
--    cột enum cũ hiện tại gần như toàn bộ là 'sapo' (không phản ánh kênh thật).
ALTER TABLE "orders" ADD COLUMN "source_name" TEXT;
UPDATE "orders" SET "source_name" = "source"::text;
ALTER TABLE "orders" DROP COLUMN "source";
