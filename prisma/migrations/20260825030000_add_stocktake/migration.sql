-- Phiếu kiểm hàng (kiểm kê tồn thực tế).
--
-- Vì sao cần: trước bảng này, lệch kiểm kê chỉ vào được hệ thống qua `POST inventory/import`
-- — sinh `inventory_movements` kiểu `adjust` không kèm chứng từ nào, nên không lần ngược
-- được ai đếm, đếm lúc nào, tồn hệ thống khi đó là bao nhiêu. Mỗi movement do phiếu này
-- sinh ra mang `reference_type = 'stocktake'` + `reference_id` trỏ về phiếu.
CREATE TYPE "StocktakeStatus" AS ENUM ('checking', 'balanced', 'cancelled');

CREATE TABLE "stocktakes" (
    "id" BIGSERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "location_id" BIGINT NOT NULL,
    "status" "StocktakeStatus" NOT NULL DEFAULT 'checking',
    "note" TEXT,
    -- Chốt lúc cân bằng: số dòng lệch và tổng lệch (dương = thừa, âm = thiếu).
    -- Lưu sẵn để danh sách phiếu không phải quét toàn bộ dòng chỉ để hiện hai con số.
    "diff_line_count" INTEGER NOT NULL DEFAULT 0,
    "diff_quantity" INTEGER NOT NULL DEFAULT 0,
    "created_by" BIGINT NOT NULL,
    "balanced_by" BIGINT,
    "balanced_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stocktakes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stocktake_items" (
    "id" BIGSERIAL NOT NULL,
    "stocktake_id" BIGINT NOT NULL,
    "variant_id" BIGINT NOT NULL,
    -- Tồn hệ thống chụp lúc thêm dòng — chỉ để biết phiếu được đếm trên nền số nào.
    -- Lệch thật lúc cân bằng vẫn đọc lại tồn hiện thời (đã khoá dòng).
    "system_quantity" INTEGER NOT NULL,
    -- NULL = chưa đếm; dòng chưa đếm bị bỏ qua khi cân bằng, không hiểu là đếm được 0
    "counted_quantity" INTEGER,
    "note" TEXT,

    CONSTRAINT "stocktake_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stocktakes_code_key" ON "stocktakes"("code");
CREATE INDEX "stocktakes_location_id_status_idx" ON "stocktakes"("location_id", "status");
CREATE INDEX "stocktakes_created_at_idx" ON "stocktakes"("created_at");

-- Một phiên bản chỉ nằm một dòng trong mỗi phiếu: thêm trùng thì cộng vào dòng cũ,
-- không tạo hai dòng đếm khác nhau cho cùng một SKU rồi cân bằng theo dòng cuối.
CREATE UNIQUE INDEX "stocktake_items_stocktake_id_variant_id_key" ON "stocktake_items"("stocktake_id", "variant_id");
CREATE INDEX "stocktake_items_variant_id_idx" ON "stocktake_items"("variant_id");

ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_balanced_by_fkey" FOREIGN KEY ("balanced_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Xoá phiếu thì xoá luôn dòng của nó (dòng không có nghĩa gì khi đứng một mình)
ALTER TABLE "stocktake_items" ADD CONSTRAINT "stocktake_items_stocktake_id_fkey" FOREIGN KEY ("stocktake_id") REFERENCES "stocktakes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stocktake_items" ADD CONSTRAINT "stocktake_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Quyền mới `inventory:stocktake`.
--
-- Phải chèn ngay trong migration chứ không chờ `prisma db seed`: deploy production chỉ chạy
-- `migrate deploy` (xem scripts/migrate-deploy.cjs + railway.toml), seed không nằm trong
-- đường deploy. Thiếu dòng này thì chỉ admin (bypass bằng cờ isAdmin) vào được màn kiểm hàng,
-- còn quản lý cửa hàng / nhân viên kho bị chặn dù catalog đã khai quyền.
INSERT INTO "permissions" ("key", "group", "label", "scope")
VALUES ('inventory:stocktake', 'Quản lý kho', 'Kiểm hàng', 'location')
ON CONFLICT ("key") DO NOTHING;

-- Gán cho đúng hai vai trò đã khai trong DEFAULT_ROLE_PERMISSIONS (store_manager,
-- warehouse_staff). Vai trò admin dùng '*' nên không cần dòng riêng.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  CROSS JOIN "permissions" p
 WHERE p."key" = 'inventory:stocktake'
   AND r."code" IN ('store_manager', 'warehouse_staff')
ON CONFLICT DO NOTHING;
