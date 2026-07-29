-- Phase 1 — Gộp branches + warehouses thành locations (theo Sapo Admin API).
-- Sapo: "Location thể hiện thông tin địa chỉ địa lý của điểm bán, kho, chi nhánh, trụ sở."
-- Dữ liệu branches/warehouses cũ là seed giả (Chi nhánh chính / Kho 1..16) nên bị thay
-- bằng 16 location thật kéo từ /admin/locations.json.
-- Dữ liệu nghiệp vụ hiện đều nằm trên warehouse_id=1 / branch_id=1 ⇒ ánh xạ về location mặc định;
-- riêng orders sẽ được backfill location_id thật theo sapo_id ở bước sau migration.

-- 1) Bảng locations
CREATE TABLE "locations" (
  "id"                       BIGSERIAL PRIMARY KEY,
  "sapo_id"                  BIGINT UNIQUE,
  "store_id"                 BIGINT,
  "code"                     TEXT UNIQUE,
  "name"                     TEXT NOT NULL,
  "email"                    TEXT,
  "phone"                    TEXT,
  "address1"                 TEXT,
  "address2"                 TEXT,
  "city"                     TEXT,
  "province"                 TEXT,
  "province_code"            TEXT,
  "district"                 TEXT,
  "district_code"            TEXT,
  "ward"                     TEXT,
  "ward_code"                TEXT,
  "country"                  TEXT,
  "country_code"             TEXT,
  "zip"                      TEXT,
  "status"                   TEXT NOT NULL DEFAULT 'active',
  "default_location"         BOOLEAN NOT NULL DEFAULT FALSE,
  "fulfill_order"            BOOLEAN NOT NULL DEFAULT FALSE,
  "fulfillment_pickup"       BOOLEAN NOT NULL DEFAULT FALSE,
  "inventory_management"     BOOLEAN NOT NULL DEFAULT TRUE,
  "deactivate_inventory_at"  TIMESTAMP(3),
  "offline_store"            BOOLEAN NOT NULL DEFAULT FALSE,
  "owner_type"               TEXT,
  "inventory_process_status" TEXT,
  "created_on"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "modified_on"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "locations_status_idx" ON "locations"("status");

-- 2) Seed 16 location thật từ Sapo
INSERT INTO "locations"
  ("sapo_id","store_id","code","name","email","phone","address1","address2","city",
   "province","province_code","district","district_code","ward","ward_code",
   "country","country_code","zip","status","default_location","fulfill_order",
   "fulfillment_pickup","inventory_management","offline_store","owner_type",
   "inventory_process_status","created_on","modified_on")
VALUES
  (813198, 561898, 'VCB01', 'Kho trung tâm (SSC)', NULL, '0986766662', '39 Cầu Diễn', NULL, NULL, 'Hà Nội', '1', 'Quận Bắc Từ Liêm', '28', 'Phường Phúc Diễn', '214', 'Vietnam', 'VN', NULL, 'active', TRUE, TRUE, TRUE, TRUE, FALSE, 'normal', 'normal', '2025-03-25T06:38:20Z'::timestamp, '2026-05-09T05:14:16Z'::timestamp),
  (931322, 561898, NULL, 'Kho Website VAT (mới)', NULL, '0986766662', '39 Cầu Diễn', NULL, NULL, 'Hà Nội', '1', 'Quận Bắc Từ Liêm', '28', 'Phường Phúc Diễn', '214', 'Vietnam', 'VN', NULL, 'active', FALSE, TRUE, TRUE, TRUE, FALSE, 'normal', 'normal', '2026-07-14T10:07:34Z'::timestamp, '2026-07-14T10:09:37Z'::timestamp),
  (920813, 561898, NULL, 'Vân Phong Các VAT', NULL, '0986766662', '39 cầu diễn', NULL, NULL, 'Hà Nội', '1', 'Quận Bắc Từ Liêm', '28', 'Phường Phúc Diễn', '214', 'Vietnam', 'VN', NULL, 'active', FALSE, TRUE, TRUE, TRUE, FALSE, 'normal', 'normal', '2026-06-02T02:22:23Z'::timestamp, '2026-06-02T02:22:50Z'::timestamp),
  (919505, 561898, NULL, 'Trung tâm VAT (Mới)', NULL, '0966438662', '39 cầu diễn', NULL, NULL, 'Hà Nội', '1', 'Quận Bắc Từ Liêm', '28', 'Phường Phúc Diễn', '214', 'Vietnam', 'VN', NULL, 'active', FALSE, TRUE, TRUE, TRUE, FALSE, 'normal', 'normal', '2026-05-27T03:56:45Z'::timestamp, '2026-05-27T03:57:22Z'::timestamp),
  (919503, 561898, NULL, 'TMDT VAT (Mới)', NULL, '0966438662', '39 Cầu Diễn', NULL, NULL, 'Hà Nội', '2001', NULL, NULL, 'Phường Xuân Phương', '200036', 'Vietnam', 'VN', NULL, 'active', FALSE, TRUE, TRUE, TRUE, FALSE, 'normal', 'normal', '2026-05-27T03:54:57Z'::timestamp, '2026-05-27T07:50:34Z'::timestamp),
  (914813, 561898, NULL, 'Chế tác Mẫu VAT (Mới)', NULL, '0966438662', '39 Cầu Diễn', NULL, NULL, 'Hà Nội', '2001', NULL, NULL, 'Phường Xuân Phương', '200036', 'Vietnam', 'VN', NULL, 'active', FALSE, TRUE, TRUE, TRUE, FALSE, 'normal', 'normal', '2026-05-08T03:27:51Z'::timestamp, '2026-05-27T03:59:59Z'::timestamp),
  (909884, 561898, NULL, '(Cũ) Kho TT VAT', NULL, '0966438662', '39 Cầu Diễn', NULL, NULL, 'Hà Nội', '2001', NULL, NULL, 'Phường Xuân Phương', '200036', 'Vietnam', 'VN', NULL, 'active', FALSE, TRUE, TRUE, TRUE, FALSE, 'normal', 'normal', '2026-04-16T11:07:56Z'::timestamp, '2026-05-27T03:55:51Z'::timestamp),
  (909370, 561898, NULL, 'STORE VAT', NULL, NULL, '39 Xã Đàn', NULL, NULL, 'Hà Nội', '2001', NULL, NULL, 'Phường Kim Liên', '200010', 'Vietnam', 'VN', NULL, 'active', FALSE, FALSE, FALSE, TRUE, FALSE, 'normal', 'normal', '2026-04-15T04:21:24Z'::timestamp, '2026-05-02T02:08:51Z'::timestamp),
  (904329, 561898, NULL, 'Kho hàng Chờ xử lý', NULL, '0966438662', '39 Cầu Diễn', NULL, NULL, 'Hà Nội', '1', 'Quận Bắc Từ Liêm', '28', 'Phường Phúc Diễn', '214', 'Vietnam', 'VN', NULL, 'active', FALSE, TRUE, TRUE, TRUE, FALSE, 'normal', 'normal', '2026-03-29T04:49:26Z'::timestamp, '2026-06-01T08:56:00Z'::timestamp),
  (885782, 561898, NULL, 'Huỷ - Kho Live VAT (SSC cũ)', NULL, '0966438662', '39 Cầu Diễn', NULL, NULL, 'Hà Nội', '2001', NULL, NULL, 'Phường Xuân Phương', '200036', 'Vietnam', 'VN', NULL, 'inactive', FALSE, TRUE, TRUE, TRUE, FALSE, 'normal', 'pending', '2026-01-09T16:10:37Z'::timestamp, '2026-07-24T10:39:11Z'::timestamp),
  (881259, 561898, NULL, 'Kho Đồ Da', NULL, '0966438662', '39 Cầu Diễn', NULL, NULL, 'Hà Nội', '1', 'Quận Bắc Từ Liêm', '28', 'Phường Phúc Diễn', '214', 'Vietnam', 'VN', NULL, 'active', FALSE, TRUE, TRUE, TRUE, FALSE, 'normal', 'normal', '2025-12-26T10:51:39Z'::timestamp, '2026-06-01T08:56:20Z'::timestamp),
  (864273, 561898, NULL, '(Huỷ) Kho Website cũ', NULL, '0966438662', '39 Cầu Diễn', NULL, NULL, 'Hà Nội', '1', 'Quận Bắc Từ Liêm', '28', 'Phường Phúc Diễn', '214', 'Vietnam', 'VN', NULL, 'inactive', FALSE, TRUE, TRUE, TRUE, FALSE, 'normal', 'pending', '2025-10-27T10:08:07Z'::timestamp, '2026-07-14T09:41:46Z'::timestamp),
  (855188, 561898, NULL, 'Media mượn', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'Vietnam', 'VN', NULL, 'active', FALSE, FALSE, FALSE, TRUE, FALSE, 'normal', 'normal', '2025-09-19T05:36:55Z'::timestamp, '2026-07-13T07:13:07Z'::timestamp),
  (855187, 561898, NULL, 'Kho Chế tác-Mẫu', NULL, '0966438662', '39 Cầu Diễn', NULL, NULL, 'Hà Nội', '1', 'Quận Bắc Từ Liêm', '28', 'Phường Phúc Diễn', '214', 'Vietnam', 'VN', NULL, 'active', FALSE, TRUE, TRUE, TRUE, FALSE, 'normal', 'normal', '2025-09-19T05:36:13Z'::timestamp, '2026-06-01T08:56:33Z'::timestamp),
  (855186, 561898, NULL, 'Kho Hàng Mượn Live', NULL, NULL, 'Mượn hàng live', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'Vietnam', 'VN', NULL, 'active', FALSE, FALSE, FALSE, TRUE, FALSE, 'normal', 'normal', '2025-09-19T05:33:59Z'::timestamp, '2026-07-24T10:39:28Z'::timestamp),
  (851502, 561898, NULL, 'STORE Cũ', NULL, '0986766662', '39 Xã Đàn', NULL, NULL, 'Hà Nội', '1', 'Quận Đống Đa', '4', 'Phường Kim Liên', '80', 'Vietnam', 'VN', NULL, 'active', FALSE, FALSE, FALSE, TRUE, FALSE, 'normal', 'normal', '2025-09-03T05:44:24Z'::timestamp, '2026-07-14T10:08:20Z'::timestamp);

-- 3) Đổi FK sang locations (mặc định trỏ về location mặc định của Sapo)
-- location mặc định: sapo_id=813198

-- orders: branch_id -> location_id
ALTER TABLE "orders" ADD COLUMN "location_id" BIGINT;
UPDATE "orders" SET "location_id" = (SELECT "id" FROM "locations" WHERE "sapo_id" = 813198);
ALTER TABLE "orders" ALTER COLUMN "location_id" SET NOT NULL;
ALTER TABLE "orders" DROP COLUMN "branch_id";
ALTER TABLE "orders" ADD CONSTRAINT "orders_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "orders_location_id_idx" ON "orders"("location_id");
CREATE INDEX "orders_location_id_status_ordered_at_idx" ON "orders"("location_id", "status", "ordered_at");

-- inventory_levels: warehouse_id -> location_id
-- Tồn kho cũ nằm hết trên kho seed giả (warehouse_id 1/2/3) nên không phản ánh thực tế;
-- dồn về một location sẽ trùng khoá (variant_id, location_id). Vì bước sau sẽ nạp lại
-- toàn bộ tồn thật từ /admin/inventory_levels.json nên xoá sạch ở đây là đúng nhất.
-- (Đã sao lưu kèm số lượng ở scratchpad/backup_phase1/inventory_levels.json.)
DELETE FROM "inventory_levels";
ALTER TABLE "inventory_levels" ADD COLUMN "location_id" BIGINT;
ALTER TABLE "inventory_levels" ALTER COLUMN "location_id" SET NOT NULL;
ALTER TABLE "inventory_levels" DROP COLUMN "warehouse_id";
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "inventory_levels_location_id_idx" ON "inventory_levels"("location_id");
ALTER TABLE "inventory_levels" ADD PRIMARY KEY ("variant_id", "location_id");
CREATE INDEX "inventory_levels_variant_id_idx" ON "inventory_levels"("variant_id");

-- inventory_movements: warehouse_id -> location_id
ALTER TABLE "inventory_movements" ADD COLUMN "location_id" BIGINT;
UPDATE "inventory_movements" SET "location_id" = (SELECT "id" FROM "locations" WHERE "sapo_id" = 813198);
ALTER TABLE "inventory_movements" ALTER COLUMN "location_id" SET NOT NULL;
ALTER TABLE "inventory_movements" DROP COLUMN "warehouse_id";
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "inventory_movements_location_id_idx" ON "inventory_movements"("location_id");
CREATE INDEX "inventory_movements_variant_location_bucket_created_idx" ON "inventory_movements"("variant_id", "location_id", "bucket", "created_at");

-- purchase_orders: warehouse_id -> location_id
ALTER TABLE "purchase_orders" ADD COLUMN "location_id" BIGINT;
UPDATE "purchase_orders" SET "location_id" = (SELECT "id" FROM "locations" WHERE "sapo_id" = 813198);
ALTER TABLE "purchase_orders" ALTER COLUMN "location_id" SET NOT NULL;
ALTER TABLE "purchase_orders" DROP COLUMN "warehouse_id";
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "purchase_orders_location_id_idx" ON "purchase_orders"("location_id");

-- goods_receipts: warehouse_id -> location_id
ALTER TABLE "goods_receipts" ADD COLUMN "location_id" BIGINT;
UPDATE "goods_receipts" SET "location_id" = (SELECT "id" FROM "locations" WHERE "sapo_id" = 813198);
ALTER TABLE "goods_receipts" ALTER COLUMN "location_id" SET NOT NULL;
ALTER TABLE "goods_receipts" DROP COLUMN "warehouse_id";
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "goods_receipts_location_id_idx" ON "goods_receipts"("location_id");

-- purchase_returns: warehouse_id -> location_id
ALTER TABLE "purchase_returns" ADD COLUMN "location_id" BIGINT;
UPDATE "purchase_returns" SET "location_id" = (SELECT "id" FROM "locations" WHERE "sapo_id" = 813198);
ALTER TABLE "purchase_returns" ALTER COLUMN "location_id" SET NOT NULL;
ALTER TABLE "purchase_returns" DROP COLUMN "warehouse_id";
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "purchase_returns_location_id_idx" ON "purchase_returns"("location_id");

-- order_return_items: warehouse_id -> location_id
ALTER TABLE "order_return_items" ADD COLUMN "location_id" BIGINT;
UPDATE "order_return_items" SET "location_id" = (SELECT "id" FROM "locations" WHERE "sapo_id" = 813198);
ALTER TABLE "order_return_items" ALTER COLUMN "location_id" SET NOT NULL;
ALTER TABLE "order_return_items" DROP COLUMN "warehouse_id";
ALTER TABLE "order_return_items" ADD CONSTRAINT "order_return_items_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "order_return_items_location_id_idx" ON "order_return_items"("location_id");

-- price_lists: branch_id -> location_id
ALTER TABLE "price_lists" ADD COLUMN "location_id" BIGINT;
UPDATE "price_lists" SET "location_id" = (SELECT "id" FROM "locations" WHERE "sapo_id" = 813198);
ALTER TABLE "price_lists" DROP COLUMN "branch_id";
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "price_lists_location_id_idx" ON "price_lists"("location_id");

-- vouchers: branch_id -> location_id
ALTER TABLE "vouchers" ADD COLUMN "location_id" BIGINT;
UPDATE "vouchers" SET "location_id" = (SELECT "id" FROM "locations" WHERE "sapo_id" = 813198);
ALTER TABLE "vouchers" ALTER COLUMN "location_id" SET NOT NULL;
ALTER TABLE "vouchers" DROP COLUMN "branch_id";
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "vouchers_location_id_idx" ON "vouchers"("location_id");
CREATE INDEX "vouchers_location_id_type_recorded_at_idx" ON "vouchers"("location_id", "type", "recorded_at");

-- draft_orders: branch_id -> location_id
ALTER TABLE "draft_orders" ADD COLUMN "location_id" BIGINT;
UPDATE "draft_orders" SET "location_id" = (SELECT "id" FROM "locations" WHERE "sapo_id" = 813198);
ALTER TABLE "draft_orders" ALTER COLUMN "location_id" SET NOT NULL;
ALTER TABLE "draft_orders" DROP COLUMN "branch_id";
ALTER TABLE "draft_orders" ADD CONSTRAINT "draft_orders_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "draft_orders_location_id_idx" ON "draft_orders"("location_id");

-- fulfillments: from_branch_id -> location_id
ALTER TABLE "fulfillments" ADD COLUMN "location_id" BIGINT;
UPDATE "fulfillments" SET "location_id" = (SELECT "id" FROM "locations" WHERE "sapo_id" = 813198);
ALTER TABLE "fulfillments" DROP COLUMN "from_branch_id";
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "fulfillments_location_id_idx" ON "fulfillments"("location_id");

-- user_warehouses: warehouse_id -> location_id
ALTER TABLE "user_warehouses" ADD COLUMN "location_id" BIGINT;
UPDATE "user_warehouses" SET "location_id" = (SELECT "id" FROM "locations" WHERE "sapo_id" = 813198);
ALTER TABLE "user_warehouses" ALTER COLUMN "location_id" SET NOT NULL;
ALTER TABLE "user_warehouses" DROP COLUMN "warehouse_id";
ALTER TABLE "user_warehouses" ADD CONSTRAINT "user_warehouses_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "user_warehouses_location_id_idx" ON "user_warehouses"("location_id");
-- Gộp kho ⇒ một user từng gán nhiều kho nay trùng (user, location): giữ lại một bản ghi.
DELETE FROM "user_warehouses" a USING "user_warehouses" b
  WHERE a.ctid < b.ctid AND a."user_id" = b."user_id" AND a."location_id" = b."location_id";
ALTER TABLE "user_warehouses" ADD PRIMARY KEY ("user_id", "location_id");

-- user_warehouse_roles: warehouse_id -> location_id
ALTER TABLE "user_warehouse_roles" ADD COLUMN "location_id" BIGINT;
UPDATE "user_warehouse_roles" SET "location_id" = (SELECT "id" FROM "locations" WHERE "sapo_id" = 813198);
ALTER TABLE "user_warehouse_roles" ALTER COLUMN "location_id" SET NOT NULL;
ALTER TABLE "user_warehouse_roles" DROP COLUMN "warehouse_id";
ALTER TABLE "user_warehouse_roles" ADD CONSTRAINT "user_warehouse_roles_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "user_warehouse_roles_location_id_idx" ON "user_warehouse_roles"("location_id");
-- Gộp kho ⇒ một user từng gán nhiều kho nay trùng (user, location): giữ lại một bản ghi.
DELETE FROM "user_warehouse_roles" a USING "user_warehouse_roles" b
  WHERE a."id" > b."id" AND a."user_id" = b."user_id" AND a."location_id" = b."location_id";
CREATE UNIQUE INDEX "user_location_roles_user_id_location_id_key" ON "user_warehouse_roles"("user_id", "location_id");

-- user_permission_overrides: warehouse_id -> location_id
ALTER TABLE "user_permission_overrides" ADD COLUMN "location_id" BIGINT;
UPDATE "user_permission_overrides" SET "location_id" = (SELECT "id" FROM "locations" WHERE "sapo_id" = 813198);
ALTER TABLE "user_permission_overrides" ALTER COLUMN "location_id" SET NOT NULL;
ALTER TABLE "user_permission_overrides" DROP COLUMN "warehouse_id";
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "user_permission_overrides_location_id_idx" ON "user_permission_overrides"("location_id");
-- Gộp kho ⇒ một user từng gán nhiều kho nay trùng (user, location): giữ lại một bản ghi.
DELETE FROM "user_permission_overrides" a USING "user_permission_overrides" b
  WHERE a."id" > b."id" AND a."user_id" = b."user_id" AND a."location_id" = b."location_id" AND a."permission_id" = b."permission_id";
CREATE UNIQUE INDEX "user_permission_overrides_user_id_location_id_permission_id_key" ON "user_permission_overrides"("user_id", "location_id", "permission_id");

-- purchase_orders còn cột branch_id thừa (đã gộp vào location_id)
ALTER TABLE "purchase_orders" DROP COLUMN "branch_id";

-- stock_transfers: hai chiều
ALTER TABLE "stock_transfers" ADD COLUMN "from_location_id" BIGINT;
ALTER TABLE "stock_transfers" ADD COLUMN "to_location_id" BIGINT;
UPDATE "stock_transfers" SET
  "from_location_id" = (SELECT "id" FROM "locations" WHERE "sapo_id" = 813198),
  "to_location_id"   = (SELECT "id" FROM "locations" WHERE "sapo_id" = 813198);
ALTER TABLE "stock_transfers" ALTER COLUMN "from_location_id" SET NOT NULL;
ALTER TABLE "stock_transfers" ALTER COLUMN "to_location_id" SET NOT NULL;
ALTER TABLE "stock_transfers" DROP COLUMN "from_warehouse_id";
ALTER TABLE "stock_transfers" DROP COLUMN "to_warehouse_id";
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_location_id_fkey" FOREIGN KEY ("from_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_location_id_fkey" FOREIGN KEY ("to_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "stock_transfers_from_location_id_idx" ON "stock_transfers"("from_location_id");
CREATE INDEX "stock_transfers_to_location_id_idx" ON "stock_transfers"("to_location_id");

-- 4) Bỏ location theo từng dòng hàng (Sapo đặt location ở cấp đơn).
--    Đã kiểm chứng 87.795/87.795 đơn chỉ dùng đúng 1 kho ⇒ không mất thông tin.
ALTER TABLE "order_items" DROP COLUMN "warehouse_id";
ALTER TABLE "draft_order_items" DROP COLUMN "warehouse_id";

-- 5) Đổi tên bảng phân quyền theo kho
ALTER TABLE "user_warehouses" RENAME TO "user_locations";
ALTER TABLE "user_warehouse_roles" RENAME TO "user_location_roles";

-- 6) inventory_levels theo đúng field Sapo
ALTER TABLE "inventory_levels" RENAME COLUMN "packing" TO "packed";
ALTER TABLE "inventory_levels" ADD COLUMN "inventory_item_id" BIGINT;
ALTER TABLE "inventory_levels" ADD COLUMN "reserved" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "inventory_levels" ADD COLUMN "incoming_owned" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "inventory_levels" ADD COLUMN "incoming_not_owned" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "inventory_levels" ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX "inventory_levels_inventory_item_id_idx" ON "inventory_levels"("inventory_item_id");

-- 7) product_variants: khoá liên kết InventoryItem của Sapo
ALTER TABLE "product_variants" ADD COLUMN "inventory_item_id" BIGINT;
CREATE UNIQUE INDEX "product_variants_inventory_item_id_key" ON "product_variants"("inventory_item_id");

-- 8) enum InventoryBucket: đổi 'packing' -> 'packed' theo Sapo.
--    RENAME VALUE an toàn trong transaction; hai giá trị mới ('available','reserved')
--    tách sang migration kế tiếp vì ADD VALUE buộc Postgres chạy ngoài transaction.
ALTER TYPE "InventoryBucket" RENAME VALUE 'packing' TO 'packed';

-- 9) PermissionScope: phạm vi quyền theo kho nay gọi là 'location'
ALTER TYPE "PermissionScope" RENAME VALUE 'warehouse' TO 'location';

-- 10) Bỏ hai bảng cũ (dữ liệu seed giả, đã thay bằng 16 location thật)
DROP TABLE "warehouses";
DROP TABLE "branches";
