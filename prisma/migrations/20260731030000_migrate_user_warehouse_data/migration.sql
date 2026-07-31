-- Chuyển dữ liệu phân quyền kho từ bảng CŨ sang bảng MỚI trước khi bỏ bảng cũ.
--
-- Migration đổi tên ở Phase 1 (`20260728040000_sapo_locations_merge`) đã tạo
-- `user_locations` / `user_location_roles`, nhưng ở database dùng `.env` dữ liệu vẫn nằm
-- nguyên trong `user_warehouses` / `user_warehouse_roles` còn hai bảng mới RỖNG. Drop bảng
-- cũ trước khi chép sẽ làm mọi người dùng mất quyền truy cập kho.
--
-- Dữ liệu nguồn bị nhân bản đúng 4 lần (cùng user, cùng kho, cùng vai trò, cùng timestamp):
--   user_warehouses      16 dòng =  4 gán kho thật
--   user_warehouse_roles 112 dòng = 28 phân vai trò thật (1 cặp trỏ vào kho đã xoá -> bỏ)
-- Nên ON CONFLICT DO NOTHING vừa khử trùng lặp vừa idempotent.
--
-- Bọc trong guard vì các môi trường đã migrate đúng (vd DB của .env.production) không còn
-- bảng cũ — migration phải chạy được ở mọi nơi.

DO $$
BEGIN
  IF to_regclass('public.user_warehouses') IS NOT NULL THEN
    INSERT INTO "user_locations" ("user_id", "location_id")
    SELECT DISTINCT uw."user_id", uw."warehouse_id"
    FROM "user_warehouses" uw
    WHERE EXISTS (SELECT 1 FROM "locations" l WHERE l."id" = uw."warehouse_id")
      AND EXISTS (SELECT 1 FROM "users" u WHERE u."id" = uw."user_id")
    ON CONFLICT DO NOTHING;
  END IF;

  IF to_regclass('public.user_warehouse_roles') IS NOT NULL THEN
    INSERT INTO "user_location_roles" ("user_id", "location_id", "role_id", "created_at")
    SELECT DISTINCT ON (r."user_id", r."warehouse_id")
           r."user_id", r."warehouse_id", r."role_id", r."created_at"
    FROM "user_warehouse_roles" r
    WHERE EXISTS (SELECT 1 FROM "locations" l WHERE l."id" = r."warehouse_id")
      AND EXISTS (SELECT 1 FROM "users" u WHERE u."id" = r."user_id")
      AND EXISTS (SELECT 1 FROM "roles" x WHERE x."id" = r."role_id")
    ORDER BY r."user_id", r."warehouse_id", r."created_at"
    ON CONFLICT DO NOTHING;
  END IF;
END $$;
