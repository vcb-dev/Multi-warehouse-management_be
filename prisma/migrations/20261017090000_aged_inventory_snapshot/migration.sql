-- Ảnh chụp hằng ngày trang sức còn hàng + số ngày tồn (FIFO theo phiếu nhập Sapo).
-- Cron 0h giờ VN ghi đè dòng của ngày hôm đó (xoá + chèn trong một transaction), nên
-- UNIQUE(snapshot_date, sapo_variant_id) vừa chặn nhân đôi vừa là khoá tra cứu.
-- product_id/variant_id là id local khớp qua sapo_id, cố ý KHÔNG FK. IF NOT EXISTS để
-- chạy lại được.
CREATE TABLE IF NOT EXISTS "aged_inventory_snapshots" (
  "id" BIGSERIAL NOT NULL,
  "snapshot_date" DATE NOT NULL,
  "sapo_product_id" BIGINT NOT NULL,
  "sapo_variant_id" BIGINT NOT NULL,
  "product_id" BIGINT,
  "variant_id" BIGINT,
  "product_name" TEXT NOT NULL,
  "product_type" TEXT,
  "product_group" TEXT NOT NULL,
  "sku" TEXT,
  "variant_title" TEXT,
  "size" TEXT,
  "color" TEXT,
  "image_url" TEXT,
  "on_hand" INTEGER NOT NULL,
  "locations" JSONB NOT NULL,
  "in_stock_since" TIMESTAMP(3) NOT NULL,
  "days_in_stock" INTEGER NOT NULL,
  "age_basis" TEXT NOT NULL,
  "last_received_on" TIMESTAMP(3),
  "layers" JSONB NOT NULL,
  "sold_30d" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "aged_inventory_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "aged_inventory_snapshots_snapshot_date_sapo_variant_id_key"
  ON "aged_inventory_snapshots" ("snapshot_date", "sapo_variant_id");

CREATE INDEX IF NOT EXISTS "aged_inventory_snapshots_snapshot_date_days_in_stock_idx"
  ON "aged_inventory_snapshots" ("snapshot_date", "days_in_stock");
