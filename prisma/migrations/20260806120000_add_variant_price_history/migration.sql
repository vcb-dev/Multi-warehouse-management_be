-- Lịch sử thay đổi giá bán / giá vốn theo SKU (ProductVariant).
-- Tái tạo migration đã bị áp thẳng vào DB dùng chung lúc 2026-08-06 09:52 UTC
-- mà chưa từng commit vào git — phát hiện qua `prisma migrate status` báo lệch
-- lịch sử. Nội dung khớp bảng `variant_price_histories` đã tồn tại trên DB.

-- CreateTable
CREATE TABLE "variant_price_histories" (
    "id" BIGSERIAL NOT NULL,
    "variant_id" BIGINT NOT NULL,
    "field" TEXT NOT NULL,
    "old_value" DECIMAL(18,2),
    "new_value" DECIMAL(18,2) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "changed_by_id" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "variant_price_histories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "variant_price_histories_variant_id_created_at_idx"
  ON "variant_price_histories"("variant_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "variant_price_histories"
  ADD CONSTRAINT "variant_price_histories_variant_id_fkey"
  FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_price_histories"
  ADD CONSTRAINT "variant_price_histories_changed_by_id_fkey"
  FOREIGN KEY ("changed_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
