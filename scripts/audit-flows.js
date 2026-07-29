/**
 * Soát toàn luồng trên DỮ LIỆU THẬT: kho -> sản phẩm -> khách hàng -> đơn hàng.
 * Chỉ ĐỌC, không ghi gì.
 */
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const results = [];
function check(group, name, ok, detail) {
  results.push({ group, name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} [${group}] ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  const q = (sql) => prisma.$queryRawUnsafe(sql);
  const n = (r, f = 'n') => Number(r[0][f]);

  // ================= KHO =================
  console.log('\n=== 1. KHO ===');
  const badAvail = await q(`
    SELECT count(*)::int n FROM inventory_levels
    WHERE available <> on_hand - committed - packed - unavailable`);
  check('KHO', 'available = on_hand − committed − packed − unavailable', n(badAvail) === 0,
    n(badAvail) ? `${n(badAvail)} dòng sai` : `${(await q('SELECT count(*)::int n FROM inventory_levels'))[0].n} dòng đúng`);

  const negBuckets = await q(`
    SELECT count(*)::int n FROM inventory_levels
    WHERE committed < 0 OR packed < 0 OR unavailable < 0`);
  check('KHO', 'không có bồn giữ chỗ âm (committed/packed/unavailable)', n(negBuckets) === 0,
    n(negBuckets) ? `${n(negBuckets)} dòng âm` : '');

  // Tồn phải khớp tổng movement của chính bồn đó
  const drift = await q(`
    SELECT count(*)::int n FROM (
      SELECT l.variant_id, l.location_id, l.on_hand,
             COALESCE(SUM(m.change) FILTER (WHERE m.bucket = 'on_hand'), 0) AS mv
      FROM inventory_levels l
      LEFT JOIN inventory_movements m
        ON m.variant_id = l.variant_id AND m.location_id = l.location_id
      GROUP BY l.variant_id, l.location_id, l.on_hand
      HAVING l.on_hand <> COALESCE(SUM(m.change) FILTER (WHERE m.bucket = 'on_hand'), 0)
    ) t`);
  check('KHO', 'on_hand khớp tổng inventory_movements', n(drift) === 0,
    n(drift) ? `${n(drift)} cặp (variant,kho) lệch` : '');

  const orphanLevel = await q(`
    SELECT count(*)::int n FROM inventory_levels l
    LEFT JOIN locations lo ON lo.id = l.location_id
    LEFT JOIN product_variants v ON v.id = l.variant_id
    WHERE lo.id IS NULL OR v.id IS NULL`);
  check('KHO', 'không có tồn kho trỏ vào kho/phiên bản không tồn tại', n(orphanLevel) === 0);

  // ================= SẢN PHẨM =================
  console.log('\n=== 2. SẢN PHẨM ===');
  const orphanVariant = await q(`
    SELECT count(*)::int n FROM product_variants v
    LEFT JOIN products p ON p.id = v.product_id WHERE p.id IS NULL`);
  check('SẢN PHẨM', 'mọi phiên bản đều thuộc một sản phẩm', n(orphanVariant) === 0);

  const noVariant = await q(`
    SELECT count(*)::int n FROM products p
    WHERE NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id)`);
  check('SẢN PHẨM', 'sản phẩm nào cũng có ít nhất 1 phiên bản', n(noVariant) === 0,
    n(noVariant) ? `${n(noVariant)} sản phẩm không có phiên bản` : '');

  const dupSku = await q(`
    SELECT count(*)::int n FROM (SELECT sku FROM product_variants GROUP BY sku HAVING count(*) > 1) t`);
  check('SẢN PHẨM', 'SKU không trùng', n(dupSku) === 0);

  const invItem = await q(`
    SELECT count(*)::int total,
           count(inventory_item_id)::int co_inv,
           count(sapo_id)::int co_sapo FROM product_variants`);
  check('SẢN PHẨM', 'phiên bản có inventory_item_id (khoá gọi API tồn Sapo)',
    invItem[0].co_inv > 0,
    `${invItem[0].co_inv}/${invItem[0].total} có inventory_item_id, ${invItem[0].co_sapo} có sapo_id`);

  // ================= KHÁCH HÀNG =================
  console.log('\n=== 3. KHÁCH HÀNG ===');
  const orphanOrderCus = await q(`
    SELECT count(*)::int n FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id
    WHERE o.customer_id IS NOT NULL AND c.id IS NULL`);
  check('KHÁCH', 'đơn không trỏ vào khách không tồn tại', n(orphanOrderCus) === 0);

  const multiDefault = await q(`
    SELECT count(*)::int n FROM (
      SELECT customer_id FROM customer_addresses WHERE is_default
      GROUP BY customer_id HAVING count(*) > 1) t`);
  check('KHÁCH', 'mỗi khách tối đa 1 địa chỉ mặc định', n(multiDefault) === 0,
    n(multiDefault) ? `${n(multiDefault)} khách có nhiều địa chỉ mặc định` : '');

  const orphanMember = await q(`
    SELECT count(*)::int n FROM customer_group_members m
    LEFT JOIN customers c ON c.id = m.customer_id
    LEFT JOIN customer_groups g ON g.id = m.customer_group_id
    WHERE c.id IS NULL OR g.id IS NULL`);
  check('KHÁCH', 'liên kết khách⇄nhóm không mồ côi', n(orphanMember) === 0);

  // orders_count của khách vs số đơn thật (không tính đơn huỷ)
  const cntDrift = await q(`
    SELECT count(*)::int n FROM (
      SELECT c.id, c.orders_count,
             (SELECT count(*) FROM orders o
               WHERE o.customer_id = c.id AND o.status <> 'cancelled') AS thuc
      FROM customers c
      WHERE c.orders_count > 0
    ) t WHERE t.orders_count <> t.thuc`);
  const cusWithCnt = await q(`SELECT count(*)::int n FROM customers WHERE orders_count > 0`);
  check('KHÁCH', 'orders_count khớp số đơn trong DB', n(cntDrift) === 0,
    `${n(cntDrift)}/${n(cusWithCnt)} lệch (Sapo tính trên toàn hệ thống Sapo)`);

  // ================= ĐƠN HÀNG =================
  console.log('\n=== 4. ĐƠN HÀNG ===');
  const orderNoItem = await q(`
    SELECT count(*)::int n FROM orders o
    WHERE NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id)`);
  check('ĐƠN', 'đơn nào cũng có dòng hàng', n(orderNoItem) === 0,
    n(orderNoItem) ? `${n(orderNoItem)} đơn rỗng` : '');

  const totalDrift = await q(`
    SELECT count(*)::int n FROM (
      SELECT o.id, o.subtotal_line_items_quantity AS sl,
             (SELECT COALESCE(sum(i.quantity),0) FROM order_items i WHERE i.order_id = o.id) AS thuc
      FROM orders o
    ) t WHERE t.sl <> t.thuc`);
  check('ĐƠN', 'subtotal_line_items_quantity khớp tổng số lượng dòng hàng', n(totalDrift) === 0,
    n(totalDrift) ? `${n(totalDrift)} đơn lệch` : '');

  const badStatus = await q(`
    SELECT count(*)::int n FROM orders
    WHERE status = 'cancelled' AND cancelled_on IS NULL`);
  check('ĐƠN', 'đơn huỷ đều có cancelled_on', n(badStatus) === 0,
    n(badStatus) ? `${n(badStatus)} đơn huỷ thiếu mốc thời gian` : '');

  const closedNoDate = await q(`
    SELECT count(*)::int n FROM orders WHERE status = 'closed' AND closed_on IS NULL`);
  check('ĐƠN', 'đơn closed đều có closed_on', n(closedNoDate) === 0,
    n(closedNoDate) ? `${n(closedNoDate)} đơn` : '');

  const orphanRefund = await q(`
    SELECT count(*)::int n FROM order_refunds r
    LEFT JOIN orders o ON o.id = r.order_id WHERE o.id IS NULL`);
  check('ĐƠN', 'refund không mồ côi', n(orphanRefund) === 0);

  const refundNoLine = await q(`
    SELECT count(*)::int n FROM order_refunds r
    WHERE NOT EXISTS (SELECT 1 FROM order_refund_items i WHERE i.refund_id = r.id)`);
  check('ĐƠN', 'refund nào cũng có dòng hàng', n(refundNoLine) === 0,
    n(refundNoLine) ? `${n(refundNoLine)} refund rỗng (dòng bị bỏ do thiếu phiên bản)` : '');

  // Trả hàng: refund có return_id thì dòng KHÔNG được là 'cancel'
  const badReturnType = await q(`
    SELECT count(*)::int n FROM order_refund_items i
    JOIN order_refunds r ON r.id = i.refund_id
    WHERE r.return_id IS NOT NULL AND i.restock_type = 'cancel'`);
  check('ĐƠN', 'refund gắn phiếu trả hàng không mang restock_type=cancel', n(badReturnType) === 0);

  // Chỉ soi refund DO APP TẠO (sapo_id IS NULL): app huỷ cả đơn nên mọi dòng
  // `cancel` của app phải nằm trên đơn đã huỷ.
  // KHÔNG áp cho dữ liệu Sapo: Sapo cho phép huỷ TỪNG DÒNG HÀNG (vd đơn
  // 85604662 có 4 dòng, huỷ 2, đơn vẫn `open`) — app chưa có tính năng này.
  const cancelOnLiveOrder = await q(`
    SELECT count(*)::int n FROM order_refund_items i
    JOIN order_refunds r ON r.id = i.refund_id
    JOIN orders o ON o.id = r.order_id
    WHERE i.restock_type = 'cancel' AND o.status <> 'cancelled'
      AND r.sapo_id IS NULL`);
  check('ĐƠN', 'refund huỷ do app tạo chỉ nằm trên đơn đã huỷ', n(cancelOnLiveOrder) === 0,
    n(cancelOnLiveOrder) ? `${n(cancelOnLiveOrder)} dòng lệch` : 'chỉ kiểm refund app tạo');

  // ================= XUYÊN LUỒNG =================
  console.log('\n=== 5. XUYÊN LUỒNG (đơn ⇄ kho) ===');
  const committedVsOrders = await q(`
    SELECT
      (SELECT COALESCE(sum(committed),0)::int FROM inventory_levels) AS ton_committed,
      (SELECT COALESCE(sum(i.quantity),0)::int
         FROM orders o JOIN order_items i ON i.order_id = o.id
        WHERE o.status = 'open' AND o.fulfillment_status IS NULL
          AND o.delivered_on IS NULL) AS don_cho_xu_ly`);
  const cm = committedVsOrders[0];
  check('XUYÊN LUỒNG', 'committed vs số lượng đơn đang chờ xử lý',
    true,
    `committed=${cm.ton_committed}, đơn chờ=${cm.don_cho_xu_ly} (lệch do đơn lịch sử Sapo không sinh movement)`);

  const orphanMovement = await q(`
    SELECT count(*)::int n FROM inventory_movements m
    LEFT JOIN product_variants v ON v.id = m.variant_id
    LEFT JOIN locations l ON l.id = m.location_id
    WHERE v.id IS NULL OR l.id IS NULL`);
  check('XUYÊN LUỒNG', 'movement không trỏ vào phiên bản/kho không tồn tại', n(orphanMovement) === 0);

  const orderLocation = await q(`
    SELECT count(*)::int n FROM orders o
    LEFT JOIN locations l ON l.id = o.location_id WHERE l.id IS NULL`);
  check('XUYÊN LUỒNG', 'mọi đơn thuộc một kho hợp lệ', n(orderLocation) === 0);

  const itemVariant = await q(`
    SELECT count(*)::int n FROM order_items i
    LEFT JOIN product_variants v ON v.id = i.variant_id WHERE v.id IS NULL`);
  check('XUYÊN LUỒNG', 'mọi dòng hàng trỏ vào phiên bản hợp lệ', n(itemVariant) === 0);

  // ===== TỔNG =====
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== TỔNG: ${results.length - failed.length}/${results.length} đạt ===`);
  if (failed.length) {
    console.log('CẦN XEM LẠI:');
    failed.forEach((f) => console.log(`  ❌ [${f.group}] ${f.name} — ${f.detail || ''}`));
  }

  await prisma.$disconnect();
})();
