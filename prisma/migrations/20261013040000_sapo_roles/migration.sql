-- Ba kiểu vai trò đang dùng trên Sapo của shop mà OMS chưa có (gom 213 tài khoản
-- theo bộ quyền từ GET /admin/users.json, 13/10/2026): "Trưởng nhóm", "Chỉ xem",
-- và bán hàng KHÔNG được sửa giá. Kèm quyền mới `order:override_price`
-- (Sapo `override_item_price`).
--
-- Đi kèm migration vì prod không chạy `prisma/seed.ts`. Khớp
-- DEFAULT_ROLE_PERMISSIONS trong permission-catalog.ts.

INSERT INTO "permissions" ("key", "group", "label", "scope")
VALUES ('order:override_price', 'Đơn hàng', 'Sửa giá bán khi tạo đơn', 'location')
ON CONFLICT ("key") DO NOTHING;

-- Ai đang tạo được đơn thì giữ nguyên khả năng đặt giá (API trước giờ nhận giá
-- bất kỳ). Gán theo quyền vai trò đang có để vai trò tự tạo không bị sót.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT DISTINCT rp."role_id", np."id"
  FROM "role_permissions" rp
  JOIN "permissions" op ON op."id" = rp."permission_id"
  CROSS JOIN "permissions" np
 WHERE op."key" = 'order:create'
   AND np."key" = 'order:override_price'
ON CONFLICT DO NOTHING;

-- Vai trò mới. ON CONFLICT để chạy lại được và không đè vai trò trùng mã nếu shop
-- đã tự tạo. `updated_at` không có DEFAULT ở DB nên phải ghi tường minh.
INSERT INTO "roles" ("code", "name", "is_system", "is_active", "updated_at") VALUES
  ('sales_fixed_price', 'Nhân viên bán hàng (không sửa giá)', false, true, CURRENT_TIMESTAMP),
  ('team_lead',         'Trưởng nhóm',                        false, true, CURRENT_TIMESTAMP),
  ('viewer',            'Chỉ xem',                            false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- Quyền của ba vai trò. Chỉ gán khi vai trò CHƯA có quyền nào — tức vừa được tạo
-- ở trên; vai trò trùng mã đã tồn tại từ trước thì để nguyên.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  JOIN (VALUES
    ('sales_fixed_price', 'dashboard:view'),
    ('sales_fixed_price', 'order:view'),
    ('sales_fixed_price', 'order:create'),
    ('sales_fixed_price', 'order:update'),
    ('sales_fixed_price', 'order_return:view'),
    ('sales_fixed_price', 'product:view'),
    ('sales_fixed_price', 'inventory:view'),
    ('sales_fixed_price', 'customer:view'),
    ('sales_fixed_price', 'customer:manage'),
    ('team_lead', 'dashboard:view'),
    ('team_lead', 'report:view'),
    ('team_lead', 'report:view_profit'),
    ('team_lead', 'staff:manage'),
    ('team_lead', 'order:view'),
    ('team_lead', 'order:create'),
    ('team_lead', 'order:update'),
    ('team_lead', 'order:override_price'),
    ('team_lead', 'order:pack'),
    ('team_lead', 'order_return:view'),
    ('team_lead', 'product:view'),
    ('team_lead', 'inventory:view'),
    ('team_lead', 'customer:view'),
    ('team_lead', 'customer:manage'),
    ('viewer', 'dashboard:view'),
    ('viewer', 'order:view'),
    ('viewer', 'order_return:view'),
    ('viewer', 'product:view'),
    ('viewer', 'inventory:view'),
    ('viewer', 'customer:view')
  ) AS want("role_code", "perm_key") ON want."role_code" = r."code"
  JOIN "permissions" p ON p."key" = want."perm_key"
 WHERE NOT EXISTS (
   SELECT 1 FROM "role_permissions" x WHERE x."role_id" = r."id"
 );
