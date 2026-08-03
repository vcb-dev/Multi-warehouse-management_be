-- schema.prisma khai báo orders.shippingMethod và product_variants.unit từ lâu,
-- nhưng chưa từng có migration nào thêm 2 cột này — DB cũ có chúng do được
-- ALTER TABLE thủ công ngoài luồng migration, còn DB mới build từ đầu bằng
-- migrate deploy thì thiếu, gây lỗi "column does not exist" khi query.
-- IF NOT EXISTS nên vô hại nếu chạy trên DB đã có sẵn 2 cột này.

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "shipping_method" TEXT;

ALTER TABLE "product_variants"
  ADD COLUMN IF NOT EXISTS "unit" TEXT;
