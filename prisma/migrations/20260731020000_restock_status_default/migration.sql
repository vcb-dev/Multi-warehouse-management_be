-- `orders.restock_status` là cột duy nhất trong bộ ba return/refund/restock bị để nullable
-- không có DEFAULT, nên nó NULL ở 100% đơn (87.911/87.911) trong khi hai cột anh em luôn
-- có giá trị. Hệ quả: mọi bộ lọc `restock_status = 'no_restock'` bỏ sót toàn bộ đơn.
--
-- `recomputeOrderRefundStatuses()` (src/modules/orders/order-refund-status.ts) vẫn ghi đè
-- giá trị đúng khi có phát sinh trả hàng/hoàn tiền, nên đặt mặc định `no_restock` là an toàn.

UPDATE "orders" SET "restock_status" = 'no_restock' WHERE "restock_status" IS NULL;

ALTER TABLE "orders" ALTER COLUMN "restock_status" SET DEFAULT 'no_restock';
ALTER TABLE "orders" ALTER COLUMN "restock_status" SET NOT NULL;
