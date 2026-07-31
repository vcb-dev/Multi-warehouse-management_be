/**
 * Audit sâu luồng HUỶ ĐƠN và TRẢ HÀNG/HOÀN TIỀN — bổ sung cho scripts/audit-flows.js
 * (script đó chỉ kiểm 4 invariant về refund và cố ý bỏ qua refund do Sapo sync tạo).
 *
 * Read-only. Chạy:
 *   set -a && . ./.env.production && set +a
 *   node scripts-tmp/audit-cancel-return.js
 */
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const results = [];
function check(group, name, ok, detail) {
  results.push({ group, name, ok });
  console.log(`  ${ok ? '✅' : '❌'} [${group}] ${name}${detail ? ` — ${detail}` : ''}`);
}
const q = (sql) => prisma.$queryRawUnsafe(sql);
const n = (rows) => Number(rows[0]?.n ?? 0);

async function main() {
  // ---------------------------------------------------------------- tổng quan
  console.log('\n=== 0. TỔNG QUAN ===');
  const overview = await q(`
    SELECT status::text, financial_status::text, count(*)::int n
    FROM orders GROUP BY 1,2 ORDER BY 1,2`);
  console.table(overview);

  const flags = await q(`
    SELECT
      count(*) FILTER (WHERE return_status  IS NOT NULL)::int co_return_status,
      count(*) FILTER (WHERE refund_status  IS NOT NULL)::int co_refund_status,
      count(*) FILTER (WHERE restock_status IS NOT NULL)::int co_restock_status,
      count(*)::int tong
    FROM orders`);
  console.log('cờ trạng thái được ghi:', flags[0]);

  // ---------------------------------------------------------------- huỷ đơn
  console.log('\n=== 1. ĐƠN HUỶ ===');

  const cancelledNoDate = await q(`
    SELECT count(*)::int n FROM orders WHERE status='cancelled' AND cancelled_on IS NULL`);
  check('HUỶ', 'đơn huỷ đều có cancelled_on', n(cancelledNoDate) === 0);

  // Huỷ đơn phải GIẢI PHÓNG chỗ đã giữ: không được còn movement committed ròng > 0
  const cancelStillCommitted = await q(`
    WITH c AS (SELECT id FROM orders WHERE status='cancelled')
    SELECT count(*)::int n FROM (
      SELECT m.reference_id, SUM(m.change)::int s
      FROM inventory_movements m
      JOIN c ON c.id = m.reference_id
      WHERE m.reference_type='order' AND m.bucket='committed'::"InventoryBucket"
      GROUP BY 1 HAVING SUM(m.change) <> 0) x`);
  check('HUỶ', 'đơn huỷ đã giải phóng hết chỗ giữ (committed ròng = 0)',
    n(cancelStillCommitted) === 0,
    n(cancelStillCommitted) ? `${n(cancelStillCommitted)} đơn còn treo committed` : '');

  // Huỷ đơn KHÔNG được trừ tồn thật nếu hàng chưa từng xuất kho
  const cancelTouchedOnHand = await q(`
    WITH c AS (SELECT id FROM orders WHERE status='cancelled')
    SELECT count(DISTINCT m.reference_id)::int n
    FROM inventory_movements m JOIN c ON c.id = m.reference_id
    WHERE m.reference_type='order' AND m.bucket='on_hand'::"InventoryBucket"`);
  check('HUỶ', 'đơn huỷ không đụng tồn thật (on_hand)', n(cancelTouchedOnHand) === 0,
    n(cancelTouchedOnHand) ? `${n(cancelTouchedOnHand)} đơn huỷ có movement on_hand — kiểm xem có phải đơn đã giao rồi mới huỷ` : '');

  // Đơn huỷ mà đã thu tiền thì phải có refund ghi nhận (hoặc financial_status phản ánh)
  const cancelPaidNoRefund = await q(`
    SELECT count(*)::int n FROM orders o
    WHERE o.status='cancelled' AND o.total_received > 0
      AND NOT EXISTS (SELECT 1 FROM order_refunds r WHERE r.order_id=o.id)`);
  check('HUỶ', 'đơn huỷ đã thu tiền đều có bản ghi hoàn tiền',
    n(cancelPaidNoRefund) === 0,
    n(cancelPaidNoRefund) ? `${n(cancelPaidNoRefund)} đơn thu tiền rồi huỷ mà không có refund` : '');

  // Vận đơn mồ côi: đơn đã huỷ nhưng fulfillment vẫn mở
  const cancelOpenFulfil = await q(`
    SELECT count(*)::int n FROM fulfillments f
    JOIN orders o ON o.id=f.order_id
    WHERE o.status='cancelled' AND f.closed_at IS NULL
      AND (f.shipment_status IS NULL OR f.shipment_status <> 'cancelled')`);
  check('HUỶ', 'đơn huỷ không còn vận đơn đang mở', n(cancelOpenFulfil) === 0,
    n(cancelOpenFulfil) ? `${n(cancelOpenFulfil)} vận đơn vẫn mở trên đơn đã huỷ` : '');

  const cancelDetail = await q(`
    SELECT o.name, o.financial_status::text fin, o.total_price::text, o.total_received::text,
           COALESCE(r.total_refunded,0)::text refunded, o.restock_status::text restock
    FROM orders o LEFT JOIN order_refunds r ON r.order_id=o.id
    WHERE o.status='cancelled' ORDER BY o.created_on DESC LIMIT 15`);
  if (cancelDetail.length) { console.log('  chi tiết đơn huỷ:'); console.table(cancelDetail); }

  // ---------------------------------------------------------------- trả hàng
  console.log('\n=== 2. TRẢ HÀNG / HOÀN TIỀN ===');

  const returnCount = await q(`SELECT count(*)::int n FROM order_returns`);
  const refundCount = await q(`SELECT count(*)::int n FROM order_refunds`);
  const refundLines = await q(`SELECT count(*)::int n FROM order_refund_items`);
  console.log(`  order_returns=${n(returnCount)}  order_refunds=${n(refundCount)}  dòng refund=${n(refundLines)}`);

  const restockDist = await q(`
    SELECT restock_type::text, count(*)::int n, SUM(quantity)::int sl
    FROM order_refund_items GROUP BY 1 ORDER BY 1`);
  if (restockDist.length) { console.log('  phân bố restock_type:'); console.table(restockDist); }

  // Hàng khách trả (return_item) PHẢI có movement nhập lại kho
  const returnNoRestock = await q(`
    SELECT count(*)::int n FROM order_refund_items ri
    JOIN order_refunds r ON r.id=ri.refund_id
    WHERE ri.restock_type='return_item'
      AND NOT EXISTS (
        SELECT 1 FROM inventory_movements m
        WHERE m.reference_type='order' AND m.reference_id=r.order_id
          AND m.variant_id=ri.variant_id
          AND m.bucket='on_hand'::"InventoryBucket" AND m.change > 0)`);
  check('TRẢ HÀNG', 'hàng khách trả đều được nhập lại kho', n(returnNoRestock) === 0,
    n(returnNoRestock) ? `${n(returnNoRestock)} dòng return_item không có movement nhập lại` : '');

  // restock_type=cancel KHÔNG được nhập lại kho (hàng chưa từng rời kho)
  const cancelRestocked = await q(`
    SELECT count(*)::int n FROM order_refund_items ri
    JOIN order_refunds r ON r.id=ri.refund_id
    JOIN orders o ON o.id=r.order_id
    WHERE ri.restock_type='cancel' AND r.restock = true`);
  check('TRẢ HÀNG', 'dòng huỷ không bị đánh dấu nhập lại kho', n(cancelRestocked) === 0);

  // Tiền hoàn không được vượt tiền đã thu
  const overRefund = await q(`
    SELECT count(*)::int n FROM (
      SELECT o.id, o.total_received, SUM(r.total_refunded) s
      FROM orders o JOIN order_refunds r ON r.order_id=o.id
      GROUP BY 1,2 HAVING SUM(r.total_refunded) > o.total_received + 0.01) x`);
  check('TRẢ HÀNG', 'tổng hoàn không vượt tổng đã thu', n(overRefund) === 0,
    n(overRefund) ? `${n(overRefund)} đơn hoàn nhiều hơn đã thu` : '');

  // orders.total_refunded phải khớp tổng refund
  const refundDrift = await q(`
    SELECT count(*)::int n FROM (
      SELECT o.id FROM orders o
      LEFT JOIN order_refunds r ON r.order_id=o.id
      GROUP BY o.id, o.total_refunded
      HAVING COALESCE(o.total_refunded,0) <> COALESCE(SUM(r.total_refunded),0)) x`);
  check('TRẢ HÀNG', 'orders.total_refunded khớp tổng order_refunds', n(refundDrift) === 0,
    n(refundDrift) ? `${n(refundDrift)} đơn lệch` : '');

  // Cờ refund_status phải phản ánh có tiền hoàn hay không
  const refundStatusDrift = await q(`
    SELECT count(*)::int n FROM orders o
    WHERE (COALESCE(o.total_refunded,0) > 0) <> (o.refund_status IN ('refunded','partial'))`);
  check('TRẢ HÀNG', 'refund_status khớp số tiền đã hoàn', n(refundStatusDrift) === 0,
    n(refundStatusDrift) ? `${n(refundStatusDrift)} đơn có cờ sai/chưa set` : '');

  // Cờ return_status phải phản ánh có phiếu trả hàng hay không
  const returnStatusDrift = await q(`
    SELECT count(*)::int n FROM orders o
    WHERE EXISTS (SELECT 1 FROM order_returns t WHERE t.order_id=o.id)
      AND (o.return_status IS NULL OR o.return_status='no_return')`);
  check('TRẢ HÀNG', 'return_status được set khi có phiếu trả hàng', n(returnStatusDrift) === 0,
    n(returnStatusDrift) ? `${n(returnStatusDrift)} đơn có phiếu trả mà cờ chưa set` : '');

  // restock_status phải được ghi khi có dòng nhập lại
  const restockStatusDrift = await q(`
    SELECT count(*)::int n FROM orders o
    WHERE EXISTS (
        SELECT 1 FROM order_refunds r JOIN order_refund_items ri ON ri.refund_id=r.id
        WHERE r.order_id=o.id AND ri.restock_type='return_item')
      AND (o.restock_status IS NULL OR o.restock_status='no_restock')`);
  check('TRẢ HÀNG', 'restock_status được set khi có hàng nhập lại', n(restockStatusDrift) === 0,
    n(restockStatusDrift) ? `${n(restockStatusDrift)} đơn nhập lại mà cờ chưa set` : '');

  // ---------------------------------------------------------------- tồn kho lệch
  console.log('\n=== 3. CHI TIẾT TỒN KHO LỆCH ===');
  const drift = await q(`
    WITH led AS (
      SELECT variant_id, location_id, SUM(change)::int s
      FROM inventory_movements WHERE bucket='on_hand'::"InventoryBucket" GROUP BY 1,2)
    SELECT p.name, v.sku, l.name AS kho,
           COALESCE(il.on_hand,0) AS levels_on_hand, COALESCE(led.s,0) AS ledger,
           COALESCE(led.s,0) - COALESCE(il.on_hand,0) AS lech
    FROM led
    FULL JOIN inventory_levels il ON il.variant_id=led.variant_id AND il.location_id=led.location_id
    LEFT JOIN product_variants v ON v.id=COALESCE(led.variant_id, il.variant_id)
    LEFT JOIN products p ON p.id=v.product_id
    LEFT JOIN locations l ON l.id=COALESCE(led.location_id, il.location_id)
    WHERE COALESCE(il.on_hand,0) <> COALESCE(led.s,0)
    ORDER BY ABS(COALESCE(led.s,0) - COALESCE(il.on_hand,0)) DESC`);
  if (drift.length) console.table(drift);
  check('KHO', 'on_hand khớp ledger movements', drift.length === 0,
    drift.length ? `${drift.length} cặp lệch, tổng ${drift.reduce((s, r) => s + Number(r.lech), 0)} đơn vị` : '');

  // Nguồn gốc movement — để biết ai đã ghi
  const bySource = await q(`
    SELECT type::text, reference_type, count(*)::int n, SUM(change)::int tong
    FROM inventory_movements WHERE bucket='on_hand'::"InventoryBucket"
    GROUP BY 1,2 ORDER BY 3 DESC`);
  console.log('  movement on_hand theo loại:'); console.table(bySource);

  // ---------------------------------------------------------------- tổng kết
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== TỔNG: ${results.length - failed.length}/${results.length} đạt ===`);
  if (failed.length) {
    console.log('CẦN XEM LẠI:');
    failed.forEach((f) => console.log(`  ❌ [${f.group}] ${f.name}`));
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
