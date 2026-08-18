-- Số hiệu phiên bản token của từng user. Tăng lên là vô hiệu hoá MỌI JWT đã phát cho
-- user đó — cách thu hồi duy nhất hiện có, vì payload JWT không mang `jti` và hệ thống
-- không lưu phiên phía server.
--
-- Không tốn thêm truy vấn: `JwtStrategy` vốn đã `findUnique` user mỗi request (cache 30s)
-- để kiểm `active`/`status`, nên chỉ đọc thêm một cột trong chính lượt đó.
--
-- Postgres 11+ thêm cột có DEFAULT không phải viết lại bảng, nên an toàn kể cả khi chạy
-- lúc đang có tải.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "token_version" INTEGER NOT NULL DEFAULT 0;
