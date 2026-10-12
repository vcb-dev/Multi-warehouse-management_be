-- Phiếu trả hàng thành một QUY TRÌNH như Sapo: tạo → nhận hàng → hoàn tiền →
-- hoàn thành (hoặc huỷ). Trước đây lập phiếu là nhập kho + chi tiền ngay, phiếu
-- không có trạng thái, không huỷ được.
--
-- Viết tay thay vì `prisma migrate dev`: DB dùng chung có sẵn nhiều lệch với
-- schema.prisma (index/FK), sinh tự động sẽ kéo theo hàng chục lệnh DROP không
-- liên quan. Mọi lệnh đều chạy lại được (IF NOT EXISTS / DO block).

DO $$ BEGIN
  CREATE TYPE "OrderReturnDocStatus" AS ENUM ('in_progress', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Cột mới của phiếu. Thêm `status` KHÔNG kèm DEFAULT trước để phân biệt được
-- phiếu cũ (NULL) lúc backfill bên dưới, rồi mới đặt DEFAULT + NOT NULL.
ALTER TABLE "order_returns"
  ADD COLUMN IF NOT EXISTS "status" "OrderReturnDocStatus",
  ADD COLUMN IF NOT EXISTS "reason_code" TEXT,
  ADD COLUMN IF NOT EXISTS "refund_amount" DECIMAL(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "refunded_amount" DECIMAL(18, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "refunded_on" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "refunded_by" BIGINT,
  ADD COLUMN IF NOT EXISTS "received_on" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "received_by" BIGINT,
  ADD COLUMN IF NOT EXISTS "restocked" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "tracking_number" TEXT,
  ADD COLUMN IF NOT EXISTS "carrier_name" TEXT,
  ADD COLUMN IF NOT EXISTS "completed_on" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "cancelled_on" TIMESTAMP(3);

-- Một số DB (bản dựng lại từ DDL) còn sót cột `refund_amount` kiểu cũ: nullable,
-- không DEFAULT. ADD COLUMN IF NOT EXISTS ở trên bỏ qua nó, nên chuẩn hoá ở đây.
UPDATE "order_returns" SET "refund_amount" = 0 WHERE "refund_amount" IS NULL;
ALTER TABLE "order_returns"
  ALTER COLUMN "refund_amount" TYPE DECIMAL(18, 2),
  ALTER COLUMN "refund_amount" SET DEFAULT 0,
  ALTER COLUMN "refund_amount" SET NOT NULL;

-- Phiếu có sẵn đều lập theo kiểu cũ (làm một lần là xong) hoặc chép từ Sapo/sàn
-- sau khi đã xử lý → coi là đã hoàn thành, lấy số liệu từ bản ghi refund của nó.
UPDATE "order_returns" r
SET
  "status" = 'completed',
  "completed_on" = r."created_on",
  "refund_amount" = COALESCE(f.total, 0),
  "refunded_amount" = COALESCE(f.total, 0),
  "refunded_on" = CASE WHEN COALESCE(f.total, 0) > 0 THEN r."created_on" END,
  "received_on" = CASE WHEN f.has_lines THEN r."created_on" END,
  "restocked" = CASE WHEN f.has_lines THEN f.restocked END
FROM (
  SELECT
    r2."id",
    SUM(rf."total_refunded") AS total,
    BOOL_OR(rf."restock") AS restocked,
    EXISTS (
      SELECT 1
      FROM "order_refund_items" li
      JOIN "order_refunds" rf2 ON rf2."id" = li."refund_id"
      WHERE rf2."return_id" = r2."id"
    ) AS has_lines
  FROM "order_returns" r2
  LEFT JOIN "order_refunds" rf ON rf."return_id" = r2."id"
  GROUP BY r2."id"
) f
WHERE f."id" = r."id" AND r."status" IS NULL;

ALTER TABLE "order_returns" ALTER COLUMN "status" SET DEFAULT 'in_progress';
ALTER TABLE "order_returns" ALTER COLUMN "status" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "order_returns_status_idx" ON "order_returns"("status");

DO $$ BEGIN
  ALTER TABLE "order_returns"
    ADD CONSTRAINT "order_returns_received_by_fkey"
    FOREIGN KEY ("received_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "order_returns"
    ADD CONSTRAINT "order_returns_refunded_by_fkey"
    FOREIGN KEY ("refunded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Hàng khách yêu cầu trả, ghi lúc lập phiếu (dòng refund chỉ có khi hàng đã về).
-- Tên `order_return_lines` chứ không phải `order_return_items`: tên sau là bảng
-- đời đầu (cột `order_return_id`/`warehouse_id`), đã DROP ở migration
-- 20260729190000 nhưng vẫn còn sót trên DB dựng lại từ DDL — CREATE IF NOT EXISTS
-- sẽ lặng lẽ dùng nhầm bảng cũ.
CREATE TABLE IF NOT EXISTS "order_return_lines" (
  "id" BIGSERIAL NOT NULL,
  "return_id" BIGINT NOT NULL,
  "order_item_id" BIGINT,
  "variant_id" BIGINT NOT NULL,
  "location_id" BIGINT NOT NULL,
  "product_name" TEXT NOT NULL,
  "sku" TEXT NOT NULL,
  "variant_title" TEXT,
  "quantity" INTEGER NOT NULL,
  "price" DECIMAL(18, 2) NOT NULL,
  "subtotal" DECIMAL(18, 2) NOT NULL DEFAULT 0,
  CONSTRAINT "order_return_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "order_return_lines_return_id_idx" ON "order_return_lines"("return_id");
CREATE INDEX IF NOT EXISTS "order_return_lines_variant_id_idx" ON "order_return_lines"("variant_id");

DO $$ BEGIN
  ALTER TABLE "order_return_lines"
    ADD CONSTRAINT "order_return_lines_return_id_fkey"
    FOREIGN KEY ("return_id") REFERENCES "order_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Phiếu cũ: chép dòng hàng từ refund sang để trang chi tiết phiếu có nội dung.
INSERT INTO "order_return_lines"
  ("return_id", "order_item_id", "variant_id", "location_id", "product_name",
   "sku", "variant_title", "quantity", "price", "subtotal")
SELECT rf."return_id", li."order_item_id", li."variant_id", li."location_id",
       li."product_name", li."sku", li."variant_title", li."quantity",
       li."price", li."subtotal"
FROM "order_refund_items" li
JOIN "order_refunds" rf ON rf."id" = li."refund_id"
WHERE rf."return_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "order_return_lines" x WHERE x."return_id" = rf."return_id"
  );
