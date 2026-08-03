-- Khử trùng lặp `inventory_levels` trước khi đặt lại khoá chính (variant_id, location_id).
--
-- Lần nạp hàng loạt ngày 30/07 đã ghi mỗi dòng tồn kho thành ĐÚNG 4 bản giống hệt nhau:
--   61.004 dòng = 15.251 tồn kho thật × 4
--   tổng on_hand 110.116 → thực tế chỉ 27.529
-- Đã kiểm: 0/15.251 nhóm có giá trị khác nhau giữa các bản sao (on_hand, committed, packed,
-- unavailable, incoming_owned, incoming_not_owned, reserved đều trùng) ⇒ giữ bản nào cũng như nhau.
--
-- Bảng này hiện KHÔNG có primary key nên mới cho phép trùng; migration drop cột cũ sẽ thêm
-- lại `PRIMARY KEY (variant_id, location_id)` và sẽ vỡ nếu không dedup trước (lỗi 23505 thật).
--
-- Cùng đợt nạp đó cũng nhân 4 các bảng `branches` / `warehouses` / `user_warehouses` /
-- `user_warehouse_roles`, nhưng cả 4 đều bị bỏ ở migration sau nên không xử lý ở đây.

DELETE FROM "inventory_levels" a
USING "inventory_levels" b
WHERE a.ctid > b.ctid
  AND a."variant_id" = b."variant_id"
  AND a."location_id" IS NOT DISTINCT FROM b."location_id";
