/**
 * Tính lại `return_status` / `refund_status` / `restock_status` cho mọi đơn có refund.
 *
 * `backfill-sapo-refunds.js` cố ý KHÔNG ghi đè 3 cờ này vì giả định chúng "đã backfill
 * trực tiếp từ Sapo ở Phase 3". Giả định đó đúng với DB gốc nhưng KHÔNG đúng với DB này:
 * bảng staging `sapo_orders` không có 3 cột đó, nên sau khi chuyển đổi chúng vẫn nằm ở giá
 * trị mặc định (no_return / no_refund / no_restock) và mâu thuẫn với 16.820 refund vừa nhập.
 *
 * Logic sao đúng theo `src/modules/orders/order-refund-status.ts`:
 *  - return_status : chỉ đếm dòng restock_type <> 'cancel' (hàng khách thực sự trả về)
 *  - refund_status : tính trên TỔNG tiền hoàn của mọi refund (kể cả refund huỷ đơn)
 *  - restock_status: chỉ dòng restock_type = 'return_item' mới tính là đã nhập lại
 *
 * Chạy thử:  set -a && . ./.env && set +a && node scripts-tmp/recompute-refund-statuses.js
 * Chạy thật: ... --apply
 */
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
});
const ROLLBACK = new Error('__dry_run__');

const SQL = `
WITH agg AS (
  SELECT o.id AS order_id,
         COALESCE(SUM(r.total_refunded), 0)                                   AS refunded,
         o.total_price,
         COALESCE(SUM(li.quantity) FILTER (WHERE li.restock_type <> 'cancel'), 0)      AS returned_qty,
         COALESCE(SUM(li.quantity) FILTER (WHERE li.restock_type = 'return_item'), 0)  AS restocked_qty,
         (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.order_id = o.id) AS ordered_qty
  FROM orders o
  JOIN order_refunds r ON r.order_id = o.id
  LEFT JOIN order_refund_items li ON li.refund_id = r.id
  GROUP BY o.id, o.total_price
)
UPDATE orders o SET
  return_status = CASE
    WHEN a.returned_qty = 0 THEN 'no_return'::"OrderReturnStatus"
    WHEN a.returned_qty >= a.ordered_qty THEN 'returned'::"OrderReturnStatus"
    ELSE 'in_progress'::"OrderReturnStatus" END,
  refund_status = CASE
    WHEN a.refunded <= 0 THEN 'no_refund'::"OrderRefundStatus"
    WHEN a.refunded >= a.total_price THEN 'refunded'::"OrderRefundStatus"
    ELSE 'partial'::"OrderRefundStatus" END,
  restock_status = CASE
    WHEN a.returned_qty = 0 OR a.restocked_qty = 0 THEN 'no_restock'::"OrderRestockStatus"
    WHEN a.restocked_qty >= a.returned_qty THEN 'restocked'::"OrderRestockStatus"
    ELSE 'partial'::"OrderRestockStatus" END
FROM agg a WHERE o.id = a.order_id`;

async function main() {
  await prisma.$transaction(
    async (tx) => {
      const before = await tx.$queryRawUnsafe(`
        SELECT return_status::text rs, refund_status::text fs, restock_status::text ks,
               count(*)::int n FROM orders GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 6`);
      console.log('TRƯỚC:');
      console.table(before);

      const n = await tx.$executeRawUnsafe(SQL);
      console.log(`\nCập nhật ${n} đơn`);

      console.log('\nSAU:');
      console.table(
        await tx.$queryRawUnsafe(`
          SELECT return_status::text rs, refund_status::text fs, restock_status::text ks,
                 count(*)::int n FROM orders GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 8`),
      );

      // Kiểm chứng: cờ phải khớp dữ liệu refund
      const bad = await tx.$queryRawUnsafe(`
        SELECT count(*)::int n FROM orders o
        WHERE (COALESCE(o.total_refunded,0) > 0) <> (o.refund_status IN ('refunded','partial'))`);
      console.log(`\nrefund_status còn lệch với total_refunded: ${bad[0].n}`);
      const noFlag = await tx.$queryRawUnsafe(`
        SELECT count(*)::int n FROM orders o
        WHERE EXISTS (SELECT 1 FROM order_returns t WHERE t.order_id=o.id)
          AND o.return_status = 'no_return'`);
      console.log(`đơn có phiếu trả mà return_status vẫn no_return: ${noFlag[0].n}`);

      if (!APPLY) throw ROLLBACK;
    },
    { timeout: 600000, maxWait: 60000 },
  );
  console.log(APPLY ? '\n✅ ĐÃ GHI THẬT' : '\n🔄 Dry-run — đã ROLLBACK');
}

main()
  .catch((e) => {
    if (e === ROLLBACK) return;
    console.error('LỖI:', e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
