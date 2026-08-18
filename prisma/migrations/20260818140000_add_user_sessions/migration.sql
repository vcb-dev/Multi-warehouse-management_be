-- Chuyển từ JWT tự chứng minh sang phiên lưu ở server.
--
-- Token phát cho client giờ là chuỗi ngẫu nhiên không mang thông tin, chỉ hợp lệ khi
-- đối chiếu được với một dòng ở bảng này. Đổi lại một lượt tra bảng mỗi request (vốn
-- đã có sẵn để kiểm active/status), ta được:
--   - thu hồi từng phiên: đánh dấu một dòng là token chết ngay, không đợi hết hạn
--   - liệt kê thiết bị đang đăng nhập
--   - không còn khoá ký nào để dò ngược offline
--
-- Chỉ lưu SHA-256 của token: rò database không kéo theo mạo danh được người dùng.
CREATE TABLE "user_sessions" (
  "id"           BIGSERIAL    NOT NULL,
  "user_id"      BIGINT       NOT NULL,
  "token_hash"   TEXT         NOT NULL,
  "user_agent"   TEXT,
  "ip_address"   TEXT,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at"   TIMESTAMP(3) NOT NULL,
  "revoked_at"   TIMESTAMP(3),

  CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_sessions_token_hash_key" ON "user_sessions"("token_hash");
CREATE INDEX "user_sessions_user_id_idx" ON "user_sessions"("user_id");
-- Cho cron dọn phiên hết hạn quét theo khoảng thời gian.
CREATE INDEX "user_sessions_expires_at_idx" ON "user_sessions"("expires_at");

ALTER TABLE "user_sessions"
  ADD CONSTRAINT "user_sessions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- `token_version` do bảng phiên thay thế: thu hồi giờ là đánh dấu dòng, không cần đếm
-- phiên bản nữa. Cột này vừa thêm ở migration trước, chưa có mã nào ngoài luồng auth dùng.
ALTER TABLE "users" DROP COLUMN IF EXISTS "token_version";
