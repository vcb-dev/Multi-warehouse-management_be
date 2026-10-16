-- Bốn quyền tách riêng theo cách Sapo chia (đối chiếu GET /admin/users.json của
-- shop, 13/10/2026): `channels`, `read_vouchers`, `total_profit_reports`,
-- `read_cost_price`. Trước đây các chức năng này dùng nhờ quyền khác
-- (`order:create`, `report:view`, `purchasing:manage`) hoặc không có quyền nào.
--
-- Phải đi kèm migration vì prod KHÔNG chạy `prisma/seed.ts`: thiếu thì chỉ admin
-- (bypass bằng cờ isAdmin) dùng được, mọi vai trò khác mất quyền ngay khi deploy.

INSERT INTO "permissions" ("key", "group", "label", "scope") VALUES
  ('channel:manage',     'Hệ thống', 'Kết nối & đồng bộ kênh bán', 'system'),
  ('voucher:view',       'Hệ thống', 'Xem sổ quỹ',                 'system'),
  ('report:view_profit', 'Hệ thống', 'Xem báo cáo lợi nhuận',      'system'),
  ('product:view_cost',  'Sản phẩm', 'Xem & sửa giá vốn',          'system')
ON CONFLICT ("key") DO NOTHING;

-- Gán theo quyền vai trò ĐANG CÓ chứ không theo mã vai trò: vai trò do shop tự
-- tạo (không nằm trong DEFAULT_ROLE_PERMISSIONS) cũng phải giữ được việc đang làm.

-- Sổ quỹ: ai đang vào được (report:view hoặc purchasing:manage) thì giữ nguyên.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT DISTINCT rp."role_id", np."id"
  FROM "role_permissions" rp
  JOIN "permissions" op ON op."id" = rp."permission_id"
  CROSS JOIN "permissions" np
 WHERE op."key" IN ('report:view', 'purchasing:manage')
   AND np."key" = 'voucher:view'
ON CONFLICT DO NOTHING;

-- Báo cáo lợi nhuận: ai đang xem báo cáo thì giữ nguyên; muốn thu hẹp thì bỏ tick
-- ở màn Vai trò.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT DISTINCT rp."role_id", np."id"
  FROM "role_permissions" rp
  JOIN "permissions" op ON op."id" = rp."permission_id"
  CROSS JOIN "permissions" np
 WHERE op."key" = 'report:view'
   AND np."key" = 'report:view_profit'
ON CONFLICT DO NOTHING;

-- Giá vốn: vai trò quản lý sản phẩm, mua hàng hoặc xem báo cáo. Vai trò chỉ bán
-- hàng / chỉ làm kho KHÔNG được gán — đây là thu hẹp có chủ đích, như Sapo.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT DISTINCT rp."role_id", np."id"
  FROM "role_permissions" rp
  JOIN "permissions" op ON op."id" = rp."permission_id"
  CROSS JOIN "permissions" np
 WHERE op."key" IN ('product:manage', 'purchasing:manage', 'report:view')
   AND np."key" = 'product:view_cost'
ON CONFLICT DO NOTHING;

-- Kênh bán: KHÔNG kế thừa từ `order:create` (đó chính là lỗ hổng cần đóng). Chỉ
-- vai trò đang được cấu hình hệ thống (`shipping:manage`) mới có.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT DISTINCT rp."role_id", np."id"
  FROM "role_permissions" rp
  JOIN "permissions" op ON op."id" = rp."permission_id"
  CROSS JOIN "permissions" np
 WHERE op."key" = 'shipping:manage'
   AND np."key" = 'channel:manage'
ON CONFLICT DO NOTHING;
