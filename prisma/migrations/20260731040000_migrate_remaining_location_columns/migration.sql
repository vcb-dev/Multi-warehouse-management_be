-- Chép nốt dữ liệu từ cột kho CŨ sang cột `location_id` mới ở các bảng nghiệp vụ còn lại.
--
-- Cùng nguyên nhân với `orders` và `user_warehouses`: ở database dùng `.env`, migration đổi
-- tên của Phase 1 đã tạo cột mới nhưng dữ liệu vẫn nằm ở cột cũ. Không chép trước thì bước
-- drop cột cũ sẽ vi phạm NOT NULL (đã gặp thật ở `goods_receipts`, lỗi 23502).
--
-- Số dòng cần chép (đo trên DB `.env`):
--   goods_receipts 28 · purchase_orders 19 · purchase_returns 5 · price_lists 1
--   vouchers 32 · user_permission_overrides 7 · stock_transfers 17 (2 cột)
--
-- Guard `to_regclass`/`information_schema` cho môi trường đã migrate đúng
-- (DB `.env.production` không còn cột cũ) — migration phải chạy được ở mọi nơi.

DO $$
DECLARE
  pair RECORD;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('goods_receipts',            'warehouse_id',      'location_id'),
      ('purchase_orders',           'branch_id',         'location_id'),
      ('purchase_returns',          'warehouse_id',      'location_id'),
      ('draft_orders',              'branch_id',         'location_id'),
      ('price_lists',               'branch_id',         'location_id'),
      ('vouchers',                  'branch_id',         'location_id'),
      ('user_permission_overrides', 'warehouse_id',      'location_id'),
      ('stock_transfers',           'from_warehouse_id', 'from_location_id'),
      ('stock_transfers',           'to_warehouse_id',   'to_location_id')
    ) AS t(tbl, old_col, new_col)
  LOOP
    -- Bỏ qua nếu bảng hoặc một trong hai cột không tồn tại ở môi trường này
    CONTINUE WHEN to_regclass('public.' || pair.tbl) IS NULL;
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=pair.tbl AND column_name=pair.old_col);
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=pair.tbl AND column_name=pair.new_col);

    -- Chỉ điền chỗ còn trống, và chỉ khi kho đích thực sự tồn tại
    EXECUTE format(
      'UPDATE %I SET %I = %I WHERE %I IS NULL AND %I IS NOT NULL
         AND EXISTS (SELECT 1 FROM locations l WHERE l.id = %I.%I)',
      pair.tbl, pair.new_col, pair.old_col, pair.new_col, pair.old_col,
      pair.tbl, pair.old_col);
  END LOOP;
END $$;
