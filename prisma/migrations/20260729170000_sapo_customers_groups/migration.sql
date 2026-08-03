-- Phase 7: căn chỉnh khách hàng + nhóm khách hàng theo Sapo Admin API.

-- =====================================================================
-- 1) CUSTOMERS: đổi tên + thêm trường Sapo
-- =====================================================================
ALTER TABLE "customers" RENAME COLUMN "created_at" TO "created_on";
ALTER TABLE "customers" ADD COLUMN "modified_on" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "customers" ADD COLUMN "state" TEXT NOT NULL DEFAULT 'enabled';
ALTER TABLE "customers" ADD COLUMN "verified_email" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "customers" ADD COLUMN "gender" TEXT;
ALTER TABLE "customers" ADD COLUMN "dob" TIMESTAMP(3);
ALTER TABLE "customers" ADD COLUMN "accepts_marketing" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "customers" ADD COLUMN "orders_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "customers" ADD COLUMN "total_spent" DECIMAL(18,2) NOT NULL DEFAULT 0;
ALTER TABLE "customers" ADD COLUMN "last_order_id" BIGINT;
ALTER TABLE "customers" ADD COLUMN "last_order_name" TEXT;

-- Backfill orders_count / total_spent / last_order từ dữ liệu đơn đã có
UPDATE "customers" c
SET "orders_count" = t.n,
    "total_spent"  = t.sum_price,
    "last_order_id" = t.last_id,
    "last_order_name" = t.last_name
FROM (
  SELECT o."customer_id",
         count(*)::int                              AS n,
         COALESCE(sum(o."total_price"), 0)          AS sum_price,
         (array_agg(o."id"   ORDER BY o."created_on" DESC))[1] AS last_id,
         (array_agg(o."name" ORDER BY o."created_on" DESC))[1] AS last_name
  FROM "orders" o
  WHERE o."customer_id" IS NOT NULL
    AND o."status" <> 'cancelled'
  GROUP BY o."customer_id"
) t
WHERE t."customer_id" = c."id";

-- =====================================================================
-- 2) CUSTOMER_GROUPS: thêm trường Sapo
-- =====================================================================
ALTER TABLE "customer_groups" RENAME COLUMN "created_at" TO "created_on";
ALTER TABLE "customer_groups" ADD COLUMN "modified_on" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "customer_groups" ADD COLUMN "sapo_id" BIGINT;
ALTER TABLE "customer_groups" ADD COLUMN "note" TEXT;
ALTER TABLE "customer_groups" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "customer_groups" ADD COLUMN "disjunctive" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "customer_groups" ADD COLUMN "rules" JSONB;
ALTER TABLE "customer_groups" ADD COLUMN "customers_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "customer_groups" ADD COLUMN "catalogs_count" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "customer_groups_sapo_id_key" ON "customer_groups"("sapo_id");

-- =====================================================================
-- 3) BẢNG MỚI: customer_addresses (Sapo `customer.addresses[]`)
-- =====================================================================
CREATE TABLE "customer_addresses" (
  "id"            BIGSERIAL PRIMARY KEY,
  "sapo_id"       BIGINT,
  "customer_id"   BIGINT NOT NULL,
  "first_name"    TEXT,
  "last_name"     TEXT,
  "phone"         TEXT,
  "company"       TEXT,
  "address1"      TEXT,
  "address2"      TEXT,
  "ward"          TEXT,
  "ward_code"     TEXT,
  "district"      TEXT,
  "district_code" TEXT,
  "province"      TEXT,
  "province_code" TEXT,
  "city"          TEXT,
  "country"       TEXT,
  "country_code"  TEXT,
  "zip"           TEXT,
  "is_default"    BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "customer_addresses_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "customer_addresses_sapo_id_key" ON "customer_addresses"("sapo_id");
CREATE INDEX "customer_addresses_customer_id_idx" ON "customer_addresses"("customer_id");

-- =====================================================================
-- 4) BẢNG MỚI: customer_group_members (khách ⇄ nhóm, nhiều-nhiều)
-- =====================================================================
CREATE TABLE "customer_group_members" (
  "customer_id"       BIGINT NOT NULL,
  "customer_group_id" BIGINT NOT NULL,
  "created_on"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("customer_id", "customer_group_id"),
  CONSTRAINT "customer_group_members_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE,
  CONSTRAINT "customer_group_members_customer_group_id_fkey"
    FOREIGN KEY ("customer_group_id") REFERENCES "customer_groups"("id") ON DELETE CASCADE
);
CREATE INDEX "customer_group_members_customer_group_id_idx" ON "customer_group_members"("customer_group_id");
