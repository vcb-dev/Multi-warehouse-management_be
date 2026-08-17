-- Hai topic cảnh báo tồn kho. Đây là MỞ RỘNG NGOÀI SAPO — Sapo không có topic webhook
-- nào cho cảnh báo tồn (gần nhất `inventory_levels/update` nghĩa là "mọi thay đổi tồn",
-- sai nghĩa và sẽ đụng nếu sau này đăng ký webhook Sapo thật). Dùng tiền tố `inventory/`
-- riêng để không lẫn với `inventory_levels/` của Sapo.

-- PostgreSQL 17: ALTER TYPE ... ADD VALUE chạy được trong transaction, nhưng KHÔNG được
-- dùng giá trị mới trong cùng transaction đó. Vì vậy migration này chỉ thêm giá trị;
-- việc chèn 2 dòng `notification_settings` tương ứng nằm ở
-- scripts/seed-notification-config.ts, chạy sau.
ALTER TYPE "NotificationTopic" ADD VALUE IF NOT EXISTS 'inventory/low_stock';
ALTER TYPE "NotificationTopic" ADD VALUE IF NOT EXISTS 'inventory/negative';
