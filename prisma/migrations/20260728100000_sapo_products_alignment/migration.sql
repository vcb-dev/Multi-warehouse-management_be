-- Phase 2 — Đổi tên field products/product_variants theo Sapo Admin API.
-- Nguồn: gọi thật /admin/products.json ngày 2026-07-28. Chi tiết:
-- docs/sapo-schema-mapping.md.

-- 1) products: đổi tên cột thuần (RENAME COLUMN giữ dữ liệu, giữ index/constraint sẵn có)
ALTER TABLE "products" RENAME COLUMN "slug" TO "alias";
ALTER TABLE "products" RENAME COLUMN "brand" TO "vendor";
ALTER TABLE "products" RENAME COLUMN "seo_title" TO "meta_title";
ALTER TABLE "products" RENAME COLUMN "seo_description" TO "meta_description";
ALTER TABLE "products" RENAME COLUMN "short_description" TO "summary";
ALTER TABLE "products" RENAME COLUMN "description" TO "content";
ALTER TABLE "products" RENAME COLUMN "published_at" TO "published_on";
ALTER TABLE "products" RENAME COLUMN "tax_industry_group" TO "vat_pit_category_code";
ALTER TABLE "products" RENAME COLUMN "created_at" TO "created_on";
ALTER TABLE "products" RENAME COLUMN "updated_at" TO "modified_on";

-- 2) products: is_published (boolean) -> status (string, theo Sapo)
ALTER TABLE "products" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'draft';
UPDATE "products" SET "status" = CASE WHEN "is_published" THEN 'active' ELSE 'draft' END;
ALTER TABLE "products" DROP COLUMN "is_published";

-- 3) products: field mới theo Sapo
ALTER TABLE "products" ADD COLUMN "template_layout" TEXT;
ALTER TABLE "products" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'normal';

-- 4) product_variants: field mới — dời xuống từ Product theo đúng Sapo (variant-level, không phải product-level)
ALTER TABLE "product_variants" ADD COLUMN "requires_shipping" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "product_variants" ADD COLUMN "taxable" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "product_variants" ADD COLUMN "inventory_management" TEXT NOT NULL DEFAULT 'bizweb';
ALTER TABLE "product_variants" ADD COLUMN "inventory_policy" TEXT NOT NULL DEFAULT 'deny';
ALTER TABLE "product_variants" ADD COLUMN "lot_management" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "product_variants" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "product_variants" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE "product_variants" ADD COLUMN "requires_components" BOOLEAN NOT NULL DEFAULT false;

-- 5) Backfill giá trị cũ từ products xuống từng variant, trước khi xóa cột cũ
UPDATE "product_variants" pv SET
  "requires_shipping" = p."requires_shipping",
  "taxable" = p."taxable",
  "inventory_management" = CASE WHEN p."track_inventory" THEN 'bizweb' ELSE '' END,
  "inventory_policy" = CASE WHEN p."allow_backorder" THEN 'continue' ELSE 'deny' END,
  "unit" = COALESCE(pv."unit", p."unit")
FROM "products" p
WHERE pv."product_id" = p."id";

-- 6) products: bỏ cột đã dời xuống variant + 2 cột chết (sapo_created_at/sapo_updated_at
--    không còn dùng vì created_on/modified_on giờ chính là timestamp thật của Sapo)
ALTER TABLE "products" DROP COLUMN "unit";
ALTER TABLE "products" DROP COLUMN "requires_shipping";
ALTER TABLE "products" DROP COLUMN "taxable";
ALTER TABLE "products" DROP COLUMN "track_inventory";
ALTER TABLE "products" DROP COLUMN "allow_backorder";
ALTER TABLE "products" DROP COLUMN "sapo_created_at";
ALTER TABLE "products" DROP COLUMN "sapo_updated_at";

-- 7) Category auto_conditions: khóa JSON "brand" -> "vendor" cho khớp field mới
UPDATE "categories"
SET "auto_conditions" = ("auto_conditions" - 'brand') || jsonb_build_object('vendor', "auto_conditions"->'brand')
WHERE "auto_conditions" ? 'brand';
