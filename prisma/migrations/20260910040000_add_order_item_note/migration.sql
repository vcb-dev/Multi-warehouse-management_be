-- Ghi chú theo TỪNG DÒNG hàng của đơn ("khắc tên", "nới size 16", "gói riêng")
-- — Sapo có sẵn ô này trên mỗi dòng, app mới chỉ có ghi chú ở cấp đơn nên mọi
-- yêu cầu riêng của một sản phẩm đều phải dồn vào một ô chung.
--
-- Cột nullable và không giá trị mặc định: Postgres chỉ sửa metadata, 175.475
-- dòng order_items không bị ghi lại. IF NOT EXISTS để chạy lại được — cột đã
-- được thêm tay vào DB dùng chung lúc phát triển, trước khi migration này merge.
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "note" TEXT;
