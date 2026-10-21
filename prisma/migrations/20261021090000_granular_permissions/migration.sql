-- Tách quyền theo từng màn: xem danh sách / xem chi tiết / từng thao tác (tạo, sửa,
-- xoá, xuất, nhập, thanh toán…), khớp DEFAULT_ROLE_PERMISSIONS trong
-- permission-catalog.ts. Đi kèm migration vì prod không chạy `prisma/seed.ts`.
--
-- Nguyên tắc: KHÔNG ai mất hay được thêm quyền thật khi deploy. Mỗi quyền mới cấp
-- cho đúng những ai trước đây làm được việc đó (theo quyền cũ đang gác endpoint),
-- admin bỏ tick sau. Quyền cũ gộp nhiều việc (`product:manage`, `purchasing:manage`…)
-- bị xoá hẳn; quyền "ma" của module đã gỡ (`draft_order:*`, `config:access`) cũng xoá.
--
-- CHỈ chạy một lần (Prisma đã tự đảm bảo): chạy lại sau khi admin đã bỏ tick sẽ cấp
-- lại quyền con theo quyền cha còn giữ (vd `order:view` → `order:export`).

-- 1. Danh mục mới (cập nhật nhãn/nhóm của quyền giữ lại).
INSERT INTO "permissions" ("key", "group", "label", "scope")
VALUES
  ('dashboard:view', 'Hệ thống', 'Xem trang tổng quan', 'system'),
  ('staff:manage', 'Hệ thống', 'Quản lý nhân viên', 'system'),
  ('role:manage', 'Hệ thống', 'Quản lý vai trò & phân quyền', 'system'),
  ('location:manage', 'Hệ thống', 'Quản lý kho / chi nhánh', 'system'),
  ('shipping:manage', 'Hệ thống', 'Cấu hình vận chuyển', 'system'),
  ('channel:manage', 'Hệ thống', 'Kết nối & đồng bộ kênh bán', 'system'),
  ('notification:manage', 'Hệ thống', 'Cấu hình thông báo', 'system'),
  ('api_key:manage', 'Hệ thống', 'Quản lý API key đối tác', 'system'),
  ('system:maintenance', 'Hệ thống', 'Bảo trì & đồng bộ dữ liệu Sapo', 'system'),
  ('report:view', 'Báo cáo', 'Xem báo cáo', 'system'),
  ('report:view_profit', 'Báo cáo', 'Xem báo cáo lợi nhuận', 'system'),
  ('report:export', 'Báo cáo', 'Xuất Excel báo cáo', 'system'),
  ('voucher:view', 'Sổ quỹ', 'Xem sổ quỹ', 'system'),
  ('order:view', 'Đơn hàng', 'Xem danh sách đơn hàng', 'location'),
  ('order:view_detail', 'Đơn hàng', 'Xem chi tiết đơn hàng', 'location'),
  ('order:create', 'Đơn hàng', 'Tạo đơn hàng', 'location'),
  ('order:update', 'Đơn hàng', 'Sửa đơn hàng', 'location'),
  ('order:apply_discount', 'Đơn hàng', 'Giảm giá khi bán', 'location'),
  ('order:override_price', 'Đơn hàng', 'Sửa giá bán khi tạo đơn', 'location'),
  ('order:payment', 'Đơn hàng', 'Ghi nhận thanh toán đơn', 'location'),
  ('order:cancel', 'Đơn hàng', 'Hủy đơn hàng', 'location'),
  ('order:export', 'Đơn hàng', 'Xuất Excel đơn hàng', 'location'),
  ('order:pack', 'Xử lý đơn & vận chuyển', 'Đóng gói & in phiếu', 'location'),
  ('shipment:view', 'Xử lý đơn & vận chuyển', 'Xem vận đơn', 'location'),
  ('shipment:create', 'Xử lý đơn & vận chuyển', 'Tạo & cập nhật vận đơn', 'location'),
  ('shipment:cancel', 'Xử lý đơn & vận chuyển', 'Hủy vận đơn', 'location'),
  ('shipment:reconcile', 'Xử lý đơn & vận chuyển', 'Đối soát vận đơn (COD)', 'location'),
  ('carrier_ticket:manage', 'Xử lý đơn & vận chuyển', 'Khiếu nại hãng vận chuyển', 'location'),
  ('order_return:view', 'Trả hàng', 'Xem danh sách trả hàng', 'location'),
  ('order_return:view_detail', 'Trả hàng', 'Xem chi tiết phiếu trả', 'location'),
  ('order_return:create', 'Trả hàng', 'Tạo phiếu trả hàng', 'location'),
  ('order_return:process', 'Trả hàng', 'Nhận hàng & hoàn tiền', 'location'),
  ('order_return:cancel', 'Trả hàng', 'Hủy phiếu trả hàng', 'location'),
  ('product:view', 'Sản phẩm', 'Xem danh sách sản phẩm', 'location'),
  ('product:view_detail', 'Sản phẩm', 'Xem chi tiết sản phẩm', 'location'),
  ('product:create', 'Sản phẩm', 'Tạo sản phẩm', 'location'),
  ('product:update', 'Sản phẩm', 'Sửa sản phẩm', 'location'),
  ('product:import', 'Sản phẩm', 'Nhập Excel sản phẩm', 'location'),
  ('product:export', 'Sản phẩm', 'Xuất Excel sản phẩm', 'location'),
  ('product:view_cost', 'Sản phẩm', 'Xem & sửa giá vốn', 'system'),
  ('category:manage', 'Sản phẩm', 'Quản lý danh mục', 'location'),
  ('price_list:view', 'Bảng giá', 'Xem bảng giá', 'location'),
  ('price_list:manage', 'Bảng giá', 'Tạo & sửa bảng giá', 'location'),
  ('customer:view', 'Khách hàng', 'Xem danh sách khách hàng', 'system'),
  ('customer:view_detail', 'Khách hàng', 'Xem chi tiết khách hàng', 'system'),
  ('customer:create', 'Khách hàng', 'Tạo khách hàng', 'system'),
  ('customer:update', 'Khách hàng', 'Sửa khách hàng', 'system'),
  ('customer:delete', 'Khách hàng', 'Xóa khách hàng', 'system'),
  ('customer:debt_adjust', 'Khách hàng', 'Điều chỉnh công nợ khách', 'system'),
  ('customer_group:manage', 'Khách hàng', 'Quản lý nhóm khách hàng', 'system'),
  ('inventory:view', 'Tồn kho', 'Xem tồn kho', 'location'),
  ('inventory:import', 'Tồn kho', 'Nhập Excel tồn & tồn ban đầu', 'location'),
  ('inventory:export', 'Tồn kho', 'Xuất Excel tồn kho', 'location'),
  ('stock_transfer:view', 'Chuyển kho', 'Xem danh sách phiếu chuyển', 'location'),
  ('stock_transfer:view_detail', 'Chuyển kho', 'Xem chi tiết phiếu chuyển', 'location'),
  ('stock_transfer:manage', 'Chuyển kho', 'Tạo, sửa & xuất chuyển kho', 'location'),
  ('stock_transfer:receive', 'Chuyển kho', 'Nhận hàng chuyển đến', 'location'),
  ('stocktake:view', 'Kiểm hàng', 'Xem danh sách phiếu kiểm', 'location'),
  ('stocktake:view_detail', 'Kiểm hàng', 'Xem chi tiết phiếu kiểm', 'location'),
  ('stocktake:manage', 'Kiểm hàng', 'Tạo & đếm hàng', 'location'),
  ('stocktake:balance', 'Kiểm hàng', 'Cân bằng kho', 'location'),
  ('purchase_order:view', 'Đặt hàng nhập', 'Xem danh sách đơn đặt hàng nhập', 'location'),
  ('purchase_order:view_detail', 'Đặt hàng nhập', 'Xem chi tiết đơn đặt hàng nhập', 'location'),
  ('purchase_order:manage', 'Đặt hàng nhập', 'Tạo, sửa & duyệt đơn đặt hàng nhập', 'location'),
  ('goods_receipt:view', 'Nhập hàng', 'Xem danh sách phiếu nhập', 'location'),
  ('goods_receipt:view_detail', 'Nhập hàng', 'Xem chi tiết phiếu nhập', 'location'),
  ('goods_receipt:manage', 'Nhập hàng', 'Tạo, xác nhận & hủy phiếu nhập', 'location'),
  ('goods_receipt:pay', 'Nhập hàng', 'Thanh toán phiếu nhập', 'location'),
  ('purchase_return:view', 'Trả hàng nhập', 'Xem danh sách trả hàng nhập', 'location'),
  ('purchase_return:view_detail', 'Trả hàng nhập', 'Xem chi tiết trả hàng nhập', 'location'),
  ('purchase_return:manage', 'Trả hàng nhập', 'Tạo phiếu trả hàng nhập', 'location'),
  ('purchase_return:refund', 'Trả hàng nhập', 'Xác nhận NCC hoàn tiền', 'location'),
  ('supplier:view', 'Nhà cung cấp', 'Xem danh sách nhà cung cấp', 'location'),
  ('supplier:view_detail', 'Nhà cung cấp', 'Xem chi tiết nhà cung cấp', 'location'),
  ('supplier:manage', 'Nhà cung cấp', 'Tạo & sửa nhà cung cấp', 'location'),
  ('supplier:delete', 'Nhà cung cấp', 'Xóa nhà cung cấp', 'location'),
  ('supplier:payment', 'Nhà cung cấp', 'Thanh toán & công nợ NCC', 'location')
ON CONFLICT ("key") DO UPDATE
   SET "group" = EXCLUDED."group",
       "label" = EXCLUDED."label",
       "scope" = EXCLUDED."scope";

-- 2. Bảng ánh xạ quyền mới ← quyền cũ cấp ra nó. Quyền nào không bị xoá mà không có
-- trong bảng (vd quyền của nhánh khác đã có trong DB) thì ánh xạ vào chính nó.
CREATE TEMP TABLE "_perm_map" ("new_key" TEXT NOT NULL, "old_key" TEXT NOT NULL);
INSERT INTO "_perm_map" ("new_key", "old_key")
VALUES
  ('dashboard:view', 'dashboard:view'),
  ('staff:manage', 'staff:manage'),
  ('role:manage', 'role:manage'),
  ('location:manage', 'staff:manage'),
  ('shipping:manage', 'shipping:manage'),
  ('channel:manage', 'channel:manage'),
  ('notification:manage', 'notification:manage'),
  ('api_key:manage', 'api_key:manage'),
  ('system:maintenance', 'role:manage'),
  ('report:view', 'report:view'),
  ('report:view_profit', 'report:view_profit'),
  ('report:export', 'report:view'),
  ('voucher:view', 'voucher:view'),
  ('order:view', 'order:view'),
  ('order:view_detail', 'order:view'),
  ('order:create', 'order:create'),
  ('order:update', 'order:update'),
  ('order:apply_discount', 'order:override_price'),
  ('order:override_price', 'order:override_price'),
  ('order:payment', 'order:update'),
  ('order:cancel', 'order:cancel'),
  ('order:export', 'order:view'),
  ('order:pack', 'order:pack'),
  ('shipment:view', 'order:view'),
  ('shipment:create', 'order:pack'),
  ('shipment:cancel', 'order:pack'),
  ('shipment:reconcile', 'order:update'),
  ('carrier_ticket:manage', 'order:pack'),
  ('order_return:view', 'order_return:view'),
  ('order_return:view_detail', 'order_return:view'),
  ('order_return:create', 'order_return:manage'),
  ('order_return:process', 'order_return:manage'),
  ('order_return:cancel', 'order_return:manage'),
  ('product:view', 'product:view'),
  ('product:view_detail', 'product:view'),
  ('product:create', 'product:manage'),
  ('product:update', 'product:manage'),
  ('product:import', 'product:manage'),
  ('product:export', 'product:manage'),
  ('product:view_cost', 'product:view_cost'),
  ('category:manage', 'product:manage'),
  ('price_list:view', 'product:manage'),
  ('price_list:manage', 'product:manage'),
  ('customer:view', 'customer:view'),
  ('customer:view_detail', 'customer:view'),
  ('customer:create', 'customer:manage'),
  ('customer:update', 'customer:manage'),
  ('customer:delete', 'customer:manage'),
  ('customer:debt_adjust', 'customer:manage'),
  ('customer_group:manage', 'customer:manage'),
  ('inventory:view', 'inventory:view'),
  ('inventory:import', 'inventory:receive'),
  ('inventory:export', 'inventory:view'),
  ('stock_transfer:view', 'inventory:transfer'),
  ('stock_transfer:view', 'inventory:view'),
  ('stock_transfer:view_detail', 'inventory:transfer'),
  ('stock_transfer:view_detail', 'inventory:view'),
  ('stock_transfer:manage', 'inventory:transfer'),
  ('stock_transfer:receive', 'inventory:transfer'),
  ('stocktake:view', 'inventory:stocktake'),
  ('stocktake:view', 'inventory:view'),
  ('stocktake:view_detail', 'inventory:stocktake'),
  ('stocktake:view_detail', 'inventory:view'),
  ('stocktake:manage', 'inventory:stocktake'),
  ('stocktake:balance', 'inventory:stocktake'),
  ('purchase_order:view', 'purchasing:manage'),
  ('purchase_order:view', 'inventory:view'),
  ('purchase_order:view_detail', 'purchasing:manage'),
  ('purchase_order:view_detail', 'inventory:view'),
  ('purchase_order:manage', 'purchasing:manage'),
  ('goods_receipt:view', 'purchasing:manage'),
  ('goods_receipt:view', 'inventory:view'),
  ('goods_receipt:view', 'inventory:receive'),
  ('goods_receipt:view_detail', 'purchasing:manage'),
  ('goods_receipt:view_detail', 'inventory:view'),
  ('goods_receipt:view_detail', 'inventory:receive'),
  ('goods_receipt:manage', 'inventory:receive'),
  ('goods_receipt:manage', 'purchasing:manage'),
  ('goods_receipt:pay', 'purchasing:manage'),
  ('purchase_return:view', 'purchasing:manage'),
  ('purchase_return:view', 'inventory:view'),
  ('purchase_return:view_detail', 'purchasing:manage'),
  ('purchase_return:view_detail', 'inventory:view'),
  ('purchase_return:manage', 'purchasing:manage'),
  ('purchase_return:manage', 'inventory:receive'),
  ('purchase_return:refund', 'purchasing:manage'),
  ('supplier:view', 'purchasing:manage'),
  ('supplier:view', 'inventory:view'),
  ('supplier:view_detail', 'purchasing:manage'),
  ('supplier:view_detail', 'inventory:view'),
  ('supplier:manage', 'purchasing:manage'),
  ('supplier:delete', 'purchasing:manage'),
  ('supplier:payment', 'purchasing:manage');
INSERT INTO "_perm_map" ("new_key", "old_key")
SELECT p."key", p."key"
  FROM "permissions" p
 WHERE p."key" NOT IN ('inventory:transfer', 'inventory:stocktake', 'inventory:receive', 'purchasing:manage', 'product:manage', 'customer:manage', 'order_return:manage', 'config:access', 'draft_order:view', 'draft_order:manage')
   AND NOT EXISTS (SELECT 1 FROM "_perm_map" m WHERE m."new_key" = p."key" AND m."old_key" = p."key");

CREATE TEMP TABLE "_removed_keys" ("key" TEXT PRIMARY KEY);
INSERT INTO "_removed_keys" ("key")
VALUES ('inventory:transfer'), ('inventory:stocktake'), ('inventory:receive'), ('purchasing:manage'), ('product:manage'), ('customer:manage'), ('order_return:manage'), ('config:access'), ('draft_order:view'), ('draft_order:manage');

-- 3. Ảnh chụp quyền vai trò + quyền riêng TRƯỚC khi đổi.
CREATE TEMP TABLE "_old_role_perms" AS
SELECT rp."role_id", p."key"
  FROM "role_permissions" rp
  JOIN "permissions" p ON p."id" = rp."permission_id";

CREATE TEMP TABLE "_old_overrides" AS
SELECT o."user_id", o."location_id", p."key", o."granted"
  FROM "user_permission_overrides" o
  JOIN "permissions" p ON p."id" = o."permission_id";

-- 4. Vai trò: có quyền cũ nào thì nhận mọi quyền mới suy ra từ nó.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT DISTINCT orp."role_id", np."id"
  FROM "_old_role_perms" orp
  JOIN "_perm_map" m ON m."old_key" = orp."key"
  JOIN "permissions" np ON np."key" = m."new_key"
ON CONFLICT DO NOTHING;

-- Admin vượt mọi kiểm tra quyền (isAdmin) nhưng màn Vai trò đếm theo bảng này —
-- gán đủ để khỏi hiện "28 quyền" trong khi admin làm được tất cả.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  CROSS JOIN "permissions" p
 WHERE r."code" = 'admin'
   AND p."key" NOT IN (SELECT "key" FROM "_removed_keys")
ON CONFLICT DO NOTHING;

-- 5. Quyền riêng từng (user, kho): dựng lại sao cho quyền HIỆU LỰC sau đổi đúng bằng
-- quyền hiệu lực trước đổi ánh xạ sang bộ mới.
--   trước  = quyền vai trò ∪ quyền riêng được thêm − quyền riêng bị bỏ
--   sau    = ánh xạ(trước)
--   vai trò sau = ánh xạ(quyền vai trò trước)
--   quyền riêng mới = (sau − vai trò sau → thêm) ∪ (vai trò sau − sau → bỏ)
-- Chỉ dựng lại các cặp có quyền riêng tham chiếu quyền bị xoá; cặp khác giữ nguyên
-- (quyền giữ lại ánh xạ vào chính nó nên không đổi).
CREATE TEMP TABLE "_pairs" AS
SELECT DISTINCT o."user_id", o."location_id"
  FROM "_old_overrides" o
 WHERE o."key" IN (SELECT "key" FROM "_removed_keys")
    OR EXISTS (
      -- quyền giữ lại nhưng giờ cấp thêm quyền mới (vd bỏ riêng `inventory:view` thì
      -- cũng phải bỏ `inventory:export`, `supplier:view`…)
      SELECT 1 FROM "_perm_map" m WHERE m."old_key" = o."key" AND m."new_key" <> o."key"
    );

CREATE TEMP TABLE "_pair_role" AS
SELECT pr."user_id", pr."location_id", ulr."role_id"
  FROM "_pairs" pr
  LEFT JOIN "user_location_roles" ulr
    ON ulr."user_id" = pr."user_id" AND ulr."location_id" = pr."location_id";

CREATE TEMP TABLE "_old_eff" AS
(
  SELECT pr."user_id", pr."location_id", orp."key"
    FROM "_pair_role" pr
    JOIN "_old_role_perms" orp ON orp."role_id" = pr."role_id"
  UNION
  SELECT o."user_id", o."location_id", o."key"
    FROM "_old_overrides" o
    JOIN "_pairs" pr ON pr."user_id" = o."user_id" AND pr."location_id" = o."location_id"
   WHERE o."granted"
)
EXCEPT
SELECT o."user_id", o."location_id", o."key"
  FROM "_old_overrides" o
 WHERE NOT o."granted";

CREATE TEMP TABLE "_new_eff" AS
SELECT DISTINCT e."user_id", e."location_id", m."new_key" AS "key"
  FROM "_old_eff" e
  JOIN "_perm_map" m ON m."old_key" = e."key";

CREATE TEMP TABLE "_new_role" AS
SELECT DISTINCT pr."user_id", pr."location_id", m."new_key" AS "key"
  FROM "_pair_role" pr
  JOIN "_old_role_perms" orp ON orp."role_id" = pr."role_id"
  JOIN "_perm_map" m ON m."old_key" = orp."key";

DELETE FROM "user_permission_overrides" o
 USING "_pairs" pr
 WHERE o."user_id" = pr."user_id" AND o."location_id" = pr."location_id";

INSERT INTO "user_permission_overrides"
  ("user_id", "location_id", "permission_id", "granted", "updated_at")
SELECT d."user_id", d."location_id", p."id", d."granted", CURRENT_TIMESTAMP
  FROM (
    SELECT "user_id", "location_id", "key", true AS "granted"
      FROM (SELECT * FROM "_new_eff" EXCEPT SELECT * FROM "_new_role") a
    UNION ALL
    SELECT "user_id", "location_id", "key", false AS "granted"
      FROM (SELECT * FROM "_new_role" EXCEPT SELECT * FROM "_new_eff") b
  ) d
  JOIN "permissions" p ON p."key" = d."key"
ON CONFLICT ("user_id", "location_id", "permission_id") DO UPDATE
   SET "granted" = EXCLUDED."granted", "updated_at" = CURRENT_TIMESTAMP;

-- 6. Người nhận thông báo lưu theo mã quyền → đổi sang quyền mới tương ứng.
UPDATE "notification_settings"
   SET "recipient_permissions" =
     array_replace(array_replace(array_replace(array_replace(array_replace(array_replace(array_replace(
       "recipient_permissions",
       'purchasing:manage', 'purchase_order:manage'),
       'order_return:manage', 'order_return:process'),
       'product:manage', 'product:update'),
       'customer:manage', 'customer:update'),
       'inventory:receive', 'goods_receipt:manage'),
       'inventory:transfer', 'stock_transfer:manage'),
       'inventory:stocktake', 'stocktake:manage')
 WHERE "recipient_permissions" && ARRAY[
   'purchasing:manage', 'order_return:manage', 'product:manage', 'customer:manage',
   'inventory:receive', 'inventory:transfer', 'inventory:stocktake'
 ]::TEXT[];

-- 7. Xoá quyền cũ (role_permissions / user_permission_overrides xoá theo CASCADE).
DELETE FROM "permissions" WHERE "key" IN (SELECT "key" FROM "_removed_keys");

DROP TABLE "_perm_map", "_removed_keys", "_old_role_perms", "_old_overrides",
  "_pairs", "_pair_role", "_old_eff", "_new_eff", "_new_role";
