-- Quay lại JWT, lần này có hai token.
--
-- Access token là JWT ngắn hạn (~15 phút) tự chứng minh — guard chỉ verify chữ ký,
-- KHÔNG tra bảng nào. Refresh token dài hạn thì ngược lại: mỗi lần dùng phải khớp một
-- dòng còn sống ở đây, và dùng xong dòng đó chết luôn (xoay vòng). Đó là chỗ duy nhất
-- còn thu hồi được, và là lý do bảng này tồn tại thay vì stateless hoàn toàn.
--
-- Tên bảng có tiền tố `user_` vì Supabase đã chiếm sẵn `auth.refresh_tokens` cho GoTrue
-- của nó. Khác schema nên không xung đột, nhưng trùng tên là mời gọi nhầm lẫn về sau.
--
-- `family_id` gom mọi token sinh ra từ cùng MỘT lần đăng nhập. Ai dùng lại một dòng đã
-- tiêu thì đó là token bị đánh cắp (bản thật đã xoay đi rồi), nên giết cả họ chứ không
-- chỉ dòng bị lộ. Access token mang `family_id` ở claim `sid`, nên đăng xuất cũng là
-- giết họ — access token còn hạn chết theo trong vòng một nhịp cache.
CREATE TABLE "user_refresh_tokens" (
  "id"         BIGSERIAL    NOT NULL,
  "user_id"    BIGINT       NOT NULL,
  "token_hash" TEXT         NOT NULL,
  "family_id"  TEXT         NOT NULL,
  "user_agent" TEXT,
  "ip_address" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "used_at"    TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),

  CONSTRAINT "user_refresh_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_refresh_tokens_token_hash_key" ON "user_refresh_tokens"("token_hash");
CREATE INDEX "user_refresh_tokens_user_id_idx" ON "user_refresh_tokens"("user_id");
-- Đường nóng: mỗi lượt resolve access token bị cache miss đều hỏi "họ này còn sống không".
CREATE INDEX "user_refresh_tokens_family_id_idx" ON "user_refresh_tokens"("family_id");
-- Cho cron dọn token hết hạn quét theo khoảng thời gian.
CREATE INDEX "user_refresh_tokens_expires_at_idx" ON "user_refresh_tokens"("expires_at");

ALTER TABLE "user_refresh_tokens"
  ADD CONSTRAINT "user_refresh_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Không migrate dữ liệu sang: token cũ là chuỗi đục `ses_…`, không sinh ra được access
-- token JWT tương ứng. Mọi người đang đăng nhập sẽ phải đăng nhập lại một lần.
DROP TABLE IF EXISTS "user_sessions";
