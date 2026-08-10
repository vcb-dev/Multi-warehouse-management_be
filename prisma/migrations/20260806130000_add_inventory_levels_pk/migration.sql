-- Khôi phục PRIMARY KEY (variant_id, location_id) trên `inventory_levels`,
-- việc mà migration 20260731060000_dedup_inventory_levels đã hứa làm ở "migration
-- sau" nhưng chưa từng viết. Đã xác nhận không còn dòng trùng lặp (variant_id,
-- location_id) trước khi thêm — bảng hiện chỉ có index thường, không có
-- constraint duy nhất nào, dẫn tới lỗi 42P10 khi dùng ON CONFLICT.

ALTER TABLE "inventory_levels"
  ADD CONSTRAINT "inventory_levels_pkey" PRIMARY KEY ("variant_id", "location_id");
