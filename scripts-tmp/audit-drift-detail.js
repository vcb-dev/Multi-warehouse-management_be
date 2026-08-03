/**
 * Truy nguyên tồn kho lệch + kiểm bổ sung sản phẩm/khách hàng/đơn hàng mà
 * scripts/audit-flows.js chưa phủ. Read-only.
 */
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const q = (sql) => prisma.$queryRawUnsafe(sql);
const n = (r) => Number(r[0]?.n ?? 0);

async function main() {
  console.log('\n=== 1. TRUY NGUYÊN TỒN KHO LỆCH ===');

  // Chuyển kho phải cân bằng: xuất kho A = nhập kho B. Lệch = hàng đang trên đường hoặc mất dấu.
  const transfer = await q(`
    SELECT SUM(change) FILTER (WHERE type='transfer_out')::int xuat,
           SUM(change) FILTER (WHERE type='transfer_in')::int nhap,
           (SUM(change) FILTER (WHERE type='transfer_out') +
            SUM(change) FILTER (WHERE type='transfer_in'))::int chenh
    FROM inventory_movements WHERE bucket='on_hand'::"InventoryBucket"`);
  console.log('  chuyển kho:', transfer[0]);

  const pendingTransfer = await q(`
    SELECT status::text, count(*)::int n FROM stock_transfers GROUP BY 1 ORDER BY 1`);
  console.log('  phiếu chuyển kho theo trạng thái:'); console.table(pendingTransfer);

  // Movement "adjust" tham chiếu 'test' = dữ liệu do script/test ghi thẳng
  const testMoves = await q(`
    SELECT reference_type, type::text, count(*)::int n, SUM(change)::int tong,
           MIN(created_at)::text tu, MAX(created_at)::text den
    FROM inventory_movements
    WHERE reference_type NOT IN ('goods_receipt','stock_transfer','purchase_return','order')
       OR reference_type IS NULL
    GROUP BY 1,2 ORDER BY 4 DESC`);
  if (testMoves.length) { console.log('  movement KHÔNG gắn chứng từ nghiệp vụ:'); console.table(testMoves); }

  // inventory_levels được cập nhật lần cuối khi nào so với movement cuối?
  const times = await q(`
    SELECT (SELECT MAX(updated_at) FROM inventory_levels)::text levels_moi_nhat,
           (SELECT MAX(created_at) FROM inventory_movements)::text movement_moi_nhat,
           (SELECT COUNT(*) FROM inventory_levels WHERE on_hand <> 0)::int levels_khac_0,
           (SELECT COUNT(*) FROM inventory_levels)::int levels_tong`);
  console.log('  mốc thời gian:', times[0]);

  // Bucket khác on_hand có lệch không
  const buckets = await q(`
    WITH led AS (
      SELECT variant_id, location_id, bucket::text b, SUM(change)::int s
      FROM inventory_movements GROUP BY 1,2,3)
    SELECT led.b AS bucket, COUNT(*)::int cap,
           COUNT(*) FILTER (WHERE
             (led.b='on_hand'     AND COALESCE(il.on_hand,0)     <> led.s) OR
             (led.b='committed'   AND COALESCE(il.committed,0)   <> led.s) OR
             (led.b='packed'      AND COALESCE(il.packed,0)      <> led.s) OR
             (led.b='unavailable' AND COALESCE(il.unavailable,0) <> led.s)
           )::int lech
    FROM led LEFT JOIN inventory_levels il
      ON il.variant_id=led.variant_id AND il.location_id=led.location_id
    GROUP BY 1 ORDER BY 1`);
  console.log('  lệch theo từng bồn:'); console.table(buckets);

  console.log('\n=== 2. SẢN PHẨM ===');
  const priceIssues = await q(`
    SELECT count(*) FILTER (WHERE price < 0)::int gia_am,
           count(*) FILTER (WHERE cost < 0)::int von_am,
           count(*) FILTER (WHERE cost = 0)::int von_bang_0,
           count(*) FILTER (WHERE price > 0 AND cost > price)::int von_lon_hon_gia,
           count(*)::int tong
    FROM product_variants`);
  console.log('  giá/giá vốn:', priceIssues[0]);

  const noLevel = await q(`
    SELECT count(*)::int n FROM product_variants v
    WHERE NOT EXISTS (SELECT 1 FROM inventory_levels il WHERE il.variant_id=v.id)`);
  console.log(`  phiên bản chưa có dòng tồn kho nào: ${n(noLevel)}`);

  console.log('\n=== 3. KHÁCH HÀNG ===');
  const dupPhone = await q(`
    SELECT count(*)::int n FROM (
      SELECT phone FROM customers WHERE phone IS NOT NULL AND phone <> ''
      GROUP BY phone HAVING count(*) > 1) x`);
  console.log(`  số điện thoại trùng: ${n(dupPhone)}`);

  const cusStats = await q(`
    SELECT count(*)::int tong,
           count(*) FILTER (WHERE phone IS NULL OR phone='')::int khong_sdt,
           count(*) FILTER (WHERE total_spent IS NOT NULL AND total_spent > 0)::int co_chi_tieu
    FROM customers`);
  console.log('  khách hàng:', cusStats[0]);

  // total_spent phải khớp tổng đơn không huỷ
  const spentDrift = await q(`
    SELECT count(*)::int n FROM (
      SELECT c.id, COALESCE(c.total_spent,0) luu,
             COALESCE(SUM(o.total_price) FILTER (WHERE o.status <> 'cancelled'),0) thuc
      FROM customers c LEFT JOIN orders o ON o.customer_id=c.id
      GROUP BY 1,2 HAVING ABS(COALESCE(c.total_spent,0) -
        COALESCE(SUM(o.total_price) FILTER (WHERE o.status <> 'cancelled'),0)) > 0.01) x`);
  console.log(`  khách có total_spent lệch với tổng đơn: ${n(spentDrift)}`);

  console.log('\n=== 4. ĐƠN HÀNG ===');
  // Tổng tiền đơn phải khớp tổng dòng hàng + phí ship − giảm giá
  const totalDrift = await q(`
    SELECT o.name, o.total_price::text don, o.sub_total_price::text tien_hang,
           o.total_discounts::text giam, o.total_shipping_price::text ship,
           SUM(oi.discounted_total)::text tong_dong
    FROM orders o JOIN order_items oi ON oi.order_id=o.id
    GROUP BY o.id, o.name, o.total_price, o.sub_total_price, o.total_discounts, o.total_shipping_price
    HAVING ABS(o.sub_total_price - SUM(oi.discounted_total)) > 0.01
    LIMIT 10`);
  if (totalDrift.length) { console.log('  ❌ đơn có sub_total_price lệch tổng dòng hàng:'); console.table(totalDrift); }
  else console.log('  ✅ sub_total_price khớp tổng dòng hàng ở mọi đơn');

  const moneyRule = await q(`
    SELECT count(*)::int n FROM orders
    WHERE ABS(total_price - (sub_total_price - total_discounts + total_tax + total_shipping_price)) > 0.01`);
  console.log(`  đơn có total_price ≠ tiền hàng − giảm + thuế + ship: ${n(moneyRule)}`);

  const overPaid = await q(`SELECT count(*)::int n FROM orders WHERE total_received > total_price + 0.01`);
  console.log(`  đơn thu quá số phải thu: ${n(overPaid)}`);

  const finDrift = await q(`
    SELECT financial_status::text, count(*)::int n,
           count(*) FILTER (WHERE total_received >= total_price AND total_price > 0)::int da_du_tien
    FROM orders GROUP BY 1 ORDER BY 1`);
  console.log('  financial_status vs tiền thực thu:'); console.table(finDrift);

  const fulfilDrift = await q(`
    SELECT count(*)::int n FROM orders o
    WHERE o.fulfillment_status='fulfilled'
      AND NOT EXISTS (SELECT 1 FROM fulfillments f
                      WHERE f.order_id=o.id AND f.shipment_status='delivered')`);
  console.log(`  đơn fulfilled mà không có vận đơn đã giao: ${n(fulfilDrift)}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
