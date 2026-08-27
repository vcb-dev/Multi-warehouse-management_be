-- Bộ lọc người dùng tự đặt tên ở các màn danh sách, hiện ra dưới dạng tab.
--
-- `query` lưu nguyên query string đã chuẩn hoá (vd `financial_status=pending&tags=vip`)
-- thay vì JSON: nó chính là thứ đã nằm trên URL, nên không cần tầng dịch giữa
-- bộ lọc đang xem và bộ lọc đã lưu, và tập tiêu chí mở rộng về sau không kéo
-- theo việc đánh phiên bản schema.
--
-- `owner_id` NULL nghĩa là bộ lọc dùng chung toàn shop; khác NULL là của riêng
-- người tạo. Xoá người dùng thì bộ lọc riêng của họ đi theo, bản dùng chung ở lại.
CREATE TABLE "saved_filters" (
  "id"         BIGSERIAL    NOT NULL,
  "resource"   TEXT         NOT NULL,
  "name"       TEXT         NOT NULL,
  "query"      TEXT         NOT NULL,
  "owner_id"   BIGINT,
  "position"   INTEGER      NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "saved_filters_pkey" PRIMARY KEY ("id")
);

-- Truy vấn duy nhất của màn danh sách: lấy bộ lọc của một resource cho một người
-- (kèm bản dùng chung), nên gộp hai cột vào một chỉ mục.
CREATE INDEX "saved_filters_resource_owner_id_idx" ON "saved_filters"("resource", "owner_id");

ALTER TABLE "saved_filters"
  ADD CONSTRAINT "saved_filters_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
