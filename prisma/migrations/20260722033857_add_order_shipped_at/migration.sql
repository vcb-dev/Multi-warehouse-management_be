-- Mốc "đã xuất hàng" tách khỏi status completed, khớp với Sapo thật
-- (badge "Đã xử lý" bật ngay khi giao hàng xong, không đợi đơn hoàn thành)
ALTER TABLE "orders" ADD COLUMN "shipped_at" TIMESTAMP(3);
