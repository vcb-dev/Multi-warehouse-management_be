-- 4 cột cuối còn dữ liệu ở tên CŨ, chặn bước đặt NOT NULL khi bỏ cột cũ.
--
-- Tìm ra bằng cách quét toàn bộ 157 cột mà `prisma migrate diff` muốn `SET NOT NULL` rồi
-- đối chiếu với dữ liệu thật — chỉ 4 cột vướng, thay vì dò từng bảng một:
--   inventory_levels.location_id    ← warehouse_id  (61.004 dòng)
--   inventory_movements.location_id ← warehouse_id  (182 dòng)
--   products.alias                  ← slug          (12.943 dòng)
--   products.modified_on            ← updated_at    (12.943 dòng)
--
-- Guard theo information_schema để chạy được cả ở môi trường đã migrate đúng.

DO $$
DECLARE
  pair RECORD;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('inventory_levels',    'warehouse_id', 'location_id'),
      ('inventory_movements', 'warehouse_id', 'location_id'),
      ('products',            'slug',         'alias'),
      ('products',            'updated_at',   'modified_on')
    ) AS t(tbl, old_col, new_col)
  LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=pair.tbl AND column_name=pair.old_col);
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=pair.tbl AND column_name=pair.new_col);

    EXECUTE format(
      'UPDATE %I SET %I = %I WHERE %I IS NULL AND %I IS NOT NULL',
      pair.tbl, pair.new_col, pair.old_col, pair.new_col, pair.old_col);
  END LOOP;
END $$;

-- `alias` có UNIQUE index: slug trùng nhau sẽ vi phạm. Gắn hậu tố id cho bản trùng thứ 2+
-- (giữ nguyên bản đầu tiên), tương tự cách đã xử lý 16 mã đơn trùng của Sapo.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='products' AND column_name='alias') THEN
    UPDATE "products" p SET "alias" = p."alias" || '-' || p."id"::text
    FROM (
      SELECT "id", row_number() OVER (PARTITION BY "alias" ORDER BY "id") AS rn
      FROM "products" WHERE "alias" IS NOT NULL
    ) d
    WHERE d."id" = p."id" AND d.rn > 1;
  END IF;
END $$;
