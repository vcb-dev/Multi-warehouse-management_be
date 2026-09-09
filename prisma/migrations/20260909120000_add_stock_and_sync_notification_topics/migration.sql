-- Hai topic MỞ RỘNG NGOÀI SAPO, cùng lý do với `inventory/*` đã thêm ở
-- 20260817060000: Sapo không có topic webhook tương ứng.
--
--   orders/out_of_stock  — đơn đang mở mà kho không đủ hàng để đóng gói. Sapo chỉ có các
--                          mốc vòng đời đơn, không có điều kiện tính từ tồn kho.
--   channel/sync_failed  — đồng bộ một kênh bán thất bại. Sapo không biết app có kéo được
--                          đơn về hay không; đây là sức khoẻ hệ thống của riêng app.
--
-- PostgreSQL 17: ALTER TYPE ... ADD VALUE chạy được trong transaction nhưng KHÔNG được
-- dùng giá trị mới trong cùng transaction đó. Vì vậy migration này chỉ thêm giá trị; việc
-- chèn dòng `notification_settings` tương ứng nằm ở scripts/seed-notification-config.ts.
ALTER TYPE "NotificationTopic" ADD VALUE IF NOT EXISTS 'orders/out_of_stock';
ALTER TYPE "NotificationTopic" ADD VALUE IF NOT EXISTS 'channel/sync_failed';
