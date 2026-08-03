/**
 * Đưa `orders.subtotal_line_items_quantity` về MỘT ngữ nghĩa duy nhất:
 * Σ `order_items.current_quantity` (số lượng CÒN LẠI sau huỷ/hoàn) — đúng như
 * Sapo định nghĩa.
 *
 * Vì sao cần: trường này đang lẫn hai ngữ nghĩa. Script
 * `backfill-line-item-quantities.js` chỉ áp được cho đơn khớp được số dòng với
 * Sapo, nên phần còn lại vẫn giữ số ĐẶT GỐC. Hệ quả đo được:
 *   - 61 đơn lệch nếu so với Σ quantity
 *   - 153 đơn lệch nếu so với Σ current_quantity
 * Đã kiểm chứng trên 25 đơn có dòng bị huỷ: subtotal của Sapo khớp
 * Σ current_quantity, không có ca nào mâu thuẫn.
 *
 * LOẠI TRỪ những đơn đang THIẾU DÒNG HÀNG (dòng trỏ tới phiên bản chưa nhập về
 * từ Sapo). Với các đơn đó header hiện tại mới là số đúng, tính lại từ dòng
 * đang lưu sẽ che mất việc thiếu dữ liệu.
 *
 * Chạy thử:  node scripts/normalize-order-line-quantity.js
 * Ghi thật:  node scripts/normalize-order-line-quantity.js --apply
 */
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

/** Đơn nghi thiếu dòng: header ≠ Σ quantity mà không có dòng nào bị huỷ. */
const EXCLUDE_SQL = `
  SELECT o.id
  FROM orders o JOIN order_items i ON i.order_id = o.id
  GROUP BY o.id, o.subtotal_line_items_quantity
  HAVING o.subtotal_line_items_quantity <> SUM(i.quantity)
     AND count(*) FILTER (WHERE i.current_quantity IS DISTINCT FROM i.quantity) = 0`;

(async () => {
  console.log(APPLY ? '>>> CHẾ ĐỘ GHI THẬT' : '>>> chạy thử, không ghi gì');

  const truoc = await prisma.$queryRawUnsafe(`
    WITH t AS (
      SELECT o.id, o.subtotal_line_items_quantity ghi,
             SUM(COALESCE(i.current_quantity, i.quantity))::int cur
      FROM orders o JOIN order_items i ON i.order_id = o.id
      GROUP BY o.id, o.subtotal_line_items_quantity)
    SELECT count(*) FILTER (WHERE ghi <> cur)::int lech, count(*)::int tong FROM t`);

  const loaiTru = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int n FROM (${EXCLUDE_SQL}) x`,
  );

  const seSua = await prisma.$queryRawUnsafe(`
    WITH t AS (
      SELECT o.id, o.subtotal_line_items_quantity ghi,
             SUM(COALESCE(i.current_quantity, i.quantity))::int cur
      FROM orders o JOIN order_items i ON i.order_id = o.id
      GROUP BY o.id, o.subtotal_line_items_quantity)
    SELECT count(*)::int n FROM t
    WHERE ghi <> cur AND id NOT IN (${EXCLUDE_SQL})`);

  console.log(`\nTRƯỚC KHI SỬA`);
  console.log(`  đơn có dòng hàng:                 ${truoc[0].tong}`);
  console.log(`  lệch so với Σ current_quantity:   ${truoc[0].lech}`);
  console.log(`  loại trừ (đơn thiếu dòng hàng):   ${loaiTru[0].n}`);
  console.log(`  sẽ cập nhật:                      ${seSua[0].n}`);

  if (APPLY) {
    const n = await prisma.$executeRawUnsafe(`
      UPDATE orders AS o
      SET subtotal_line_items_quantity = t.cur
      FROM (
        SELECT i.order_id, SUM(COALESCE(i.current_quantity, i.quantity))::int cur
        FROM order_items i GROUP BY i.order_id
      ) t
      WHERE o.id = t.order_id
        AND o.subtotal_line_items_quantity <> t.cur
        AND o.id NOT IN (${EXCLUDE_SQL})`);
    console.log(`\nĐã cập nhật ${n} đơn.`);

    const sau = await prisma.$queryRawUnsafe(`
      WITH t AS (
        SELECT o.id, o.subtotal_line_items_quantity ghi,
               SUM(COALESCE(i.current_quantity, i.quantity))::int cur
        FROM orders o JOIN order_items i ON i.order_id = o.id
        GROUP BY o.id, o.subtotal_line_items_quantity)
      SELECT count(*) FILTER (WHERE ghi <> cur)::int lech FROM t`);
    console.log(
      `Còn lệch: ${sau[0].lech} (kỳ vọng = số đơn bị loại trừ ở trên).`,
    );
  } else {
    console.log(`\nChưa ghi gì. Thêm --apply để cập nhật.`);
  }
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
