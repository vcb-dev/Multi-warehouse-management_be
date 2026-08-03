-- Phase 4: căn chỉnh users theo Sapo Admin API field-for-field.
-- users hiện KHÔNG đồng bộ với Sapo (không sapo_id nào khớp thật với 9 tài
-- khoản nội bộ hiện có) — đây thuần là đổi tên/thêm field, không backfill
-- dữ liệu thật từ Sapo.

-- 1) Rename cột 1:1 (giữ dữ liệu, tự cập nhật index)
ALTER TABLE "users" RENAME COLUMN "phone" TO "phone_number";
ALTER TABLE "users" RENAME COLUMN "avatar_url" TO "url";
ALTER TABLE "users" RENAME COLUMN "is_active" TO "active";
ALTER TABLE "users" RENAME COLUMN "created_at" TO "created_on";
ALTER TABLE "users" RENAME COLUMN "updated_at" TO "modified_on";

-- 2) Thêm cột mới
ALTER TABLE "users" ADD COLUMN "sapo_id" BIGINT;
ALTER TABLE "users" ADD COLUMN "first_name" TEXT;
ALTER TABLE "users" ADD COLUMN "last_name" TEXT;
ALTER TABLE "users" ADD COLUMN "sapo_roles" TEXT;
ALTER TABLE "users" ADD COLUMN "sapo_permissions" JSONB;

-- 3) Backfill first_name = name cũ (không tách họ/tên tự động — dữ liệu
-- thật của Sapo cũng để last_name NULL khi chỉ có 1 từ, vd tài khoản
-- "admin"; tách sai vd "User 1" -> last_name "1" còn rủi ro hơn không tách).
UPDATE "users" SET "first_name" = "name";

-- 4) Bỏ cột cũ + thêm ràng buộc unique cho sapo_id
ALTER TABLE "users" DROP COLUMN "name";
CREATE UNIQUE INDEX "users_sapo_id_key" ON "users"("sapo_id");
