-- Thông tin người gửi riêng từng kho (tên shop khách nhận ra + SĐT gọi lại), in trên
-- phiếu giao và gửi sang hãng vận chuyển khi tạo vận đơn. Để trống thì vẫn dùng
-- name/phone của kho như trước. IF NOT EXISTS để chạy lại được.
ALTER TABLE "locations" ADD COLUMN IF NOT EXISTS "sender_name" TEXT;
ALTER TABLE "locations" ADD COLUMN IF NOT EXISTS "sender_phone" TEXT;
