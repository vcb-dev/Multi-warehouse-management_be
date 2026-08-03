/**
 * Chuyển dữ liệu DB `.env` từ định dạng cột CŨ sang schema Sapo hiện tại.
 *
 * Bối cảnh: ngày 30/07 có một lần nạp hàng loạt ghi 87.925 đơn vào DB này ở định dạng cột
 * cũ (`code`, `branch_id`, `status` kiểu text, `payment_status`...), trong khi các cột Sapo
 * mới hoàn toàn rỗng. Backend hiện tại không đọc được dữ liệu đó.
 *
 * Nguồn số liệu KHÔNG phải cột cũ của app mà là bảng staging `sapo_orders` (87.893 dòng,
 * đã đúng vốn từ Sapo: open/closed/cancelled, paid/pending/..., source_name thật) — chính
 * xác hơn hẳn. Riêng `location_id` không có trong staging nên lấy từ Sapo API qua
 * `scripts-tmp/fetch-order-locations.js` (file order-locations.jsonl).
 *
 * Chạy thử (mặc định, ROLLBACK cuối):
 *   set -a && . ./.env && set +a && node scripts-tmp/convert-env-db.js
 * Chạy thật:
 *   ... node scripts-tmp/convert-env-db.js --apply
 *
 * KHÔNG drop cột/bảng cũ ở đây — việc đó để một Prisma migration riêng chạy sau khi
 * số liệu đã được xác nhận đúng.
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');
const JSONL = path.join(__dirname, 'order-locations.jsonl');
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
});
const ROLLBACK = new Error('__dry_run__');

async function main() {
  if (!fs.existsSync(JSONL)) {
    throw new Error(`Chưa có ${JSONL} — chạy fetch-order-locations.js trước`);
  }
  const pairs = new Map();
  for (const line of fs.readFileSync(JSONL, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const { id, location_id } = JSON.parse(line);
    if (id != null && location_id != null) pairs.set(String(id), String(location_id));
  }
  console.log(`Đọc ${pairs.size} cặp (sapo_order_id → sapo_location_id) từ JSONL`);

  await prisma.$transaction(
    async (tx) => {
      const ex = (sql, ...a) => tx.$executeRawUnsafe(sql, ...a);
      const qy = (sql) => tx.$queryRawUnsafe(sql);

      // ---------------------------------------------------------- 1. đơn rác
      const orphan = await qy(`SELECT count(*)::int n FROM orders WHERE sapo_id IS NULL`);
      await ex(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE sapo_id IS NULL)`);
      const delOrders = await ex(`DELETE FROM orders WHERE sapo_id IS NULL`);
      console.log(`1. Xoá ${delOrders} đơn không có sapo_id (đơn test CNHN*, dự kiến ${orphan[0].n})`);

      // ---------------------------------------- 2. bảng tạm ánh xạ location
      await ex(`CREATE TEMP TABLE tmp_loc (sapo_order_id BIGINT PRIMARY KEY, sapo_location_id BIGINT) ON COMMIT DROP`);
      const rows = [...pairs.entries()];
      for (let i = 0; i < rows.length; i += 5000) {
        const chunk = rows.slice(i, i + 5000);
        await ex(
          `INSERT INTO tmp_loc (sapo_order_id, sapo_location_id) VALUES ${chunk
            .map((r) => `(${r[0]}, ${r[1]})`)
            .join(',')} ON CONFLICT DO NOTHING`,
        );
      }
      const locOk = await qy(`SELECT count(*)::int n FROM tmp_loc t
        JOIN locations l ON l.sapo_id = t.sapo_location_id`);
      console.log(`2. Nạp ${rows.length} ánh xạ; khớp được locations: ${locOk[0].n}`);

      // --------------------------------- 3. backfill orders từ Sapo
      // `orders.name` có UNIQUE index nhưng Sapo có 16 mã trùng (32 đơn, đều bị tạo lặp
      // ngày 2025-10-03 — cùng mã, cùng tiền, khác sapo_id). Giữ CẢ HAI bản: bản sapo_id
      // nhỏ nhất giữ mã gốc, bản sau gắn hậu tố sapo_id để vẫn truy ngược được.
      await ex(`CREATE TEMP TABLE tmp_name AS
        SELECT sapo_id,
               CASE WHEN row_number() OVER (PARTITION BY code ORDER BY sapo_id) = 1
                    THEN code ELSE code || '-' || sapo_id::text END AS name
        FROM sapo_orders`);
      await ex(`CREATE UNIQUE INDEX ON tmp_name (sapo_id)`);
      const dupFixed = await qy(`SELECT count(*)::int n FROM tmp_name t
        JOIN sapo_orders s ON s.sapo_id=t.sapo_id WHERE t.name <> s.code`);
      console.log(`3. Xử lý ${dupFixed[0].n} mã trùng bằng hậu tố sapo_id`);

      const upd = await ex(`
        UPDATE orders o SET
          name                        = nm.name,
          status                      = s.sapo_status::"OrderStatus",
          financial_status            = COALESCE(s.financial_status::"OrderFinancialStatus", 'pending'),
          fulfillment_status          = s.fulfillment_status::"OrderFulfillmentStatus",
          source_name                 = s.source_name,
          currency                    = COALESCE(s.currency, 'VND'),
          gateway                     = s.gateway,
          email                       = s.email,
          phone                       = s.phone,
          note                        = s.note,
          tags                        = COALESCE(s.tags, ARRAY[]::text[]),
          cancel_reason               = s.cancel_reason,
          sub_total_price             = COALESCE(s.subtotal_price, 0),
          total_discounts             = COALESCE(s.total_discounts, 0),
          total_tax                   = COALESCE(s.total_tax, 0),
          total_shipping_price        = COALESCE(s.total_shipping_price, 0),
          total_price                 = COALESCE(s.total_price, 0),
          total_received              = COALESCE(s.total_received, 0),
          total_refunded              = s.total_refunded,
          total_outstanding           = s.total_outstanding,
          unpaid_amount               = s.unpaid_amount,
          subtotal_line_items_quantity= COALESCE(s.item_quantity, 0),
          created_on                  = s.created_on,
          modified_on                 = COALESCE(s.modified_on, s.created_on),
          paid_on                     = s.paid_on,
          cancelled_on                = s.cancelled_on,
          closed_on                   = s.closed_on,
          expected_delivery_date      = s.expected_delivery_date,
          shipping_name               = s.ship_name,
          shipping_phone              = s.ship_phone,
          shipping_company            = s.ship_company,
          shipping_address1           = s.ship_address1,
          shipping_address2           = s.ship_address2,
          shipping_ward               = s.ship_ward,
          shipping_district           = s.ship_district,
          shipping_city               = s.ship_city,
          shipping_province           = s.ship_province,
          shipping_country            = s.ship_country,
          shipping_zip                = s.ship_zip,
          billing_name                = s.bill_name,
          billing_phone               = s.bill_phone,
          billing_address1            = s.bill_address1,
          billing_district            = s.bill_district,
          billing_province            = s.bill_province,
          billing_country             = s.bill_country,
          user_id                     = COALESCE(o.user_id, o.created_by),
          assignee_id                 = COALESCE(o.assignee_id, o.assigned_to),
          location_id                 = COALESCE(l.id, o.location_id)
        FROM sapo_orders s
        JOIN tmp_name nm      ON nm.sapo_id      = s.sapo_id
        LEFT JOIN tmp_loc t   ON t.sapo_order_id = s.sapo_id
        LEFT JOIN locations l ON l.sapo_id       = t.sapo_location_id
        WHERE o.sapo_id = s.sapo_id`);
      console.log(`   Backfill ${upd} đơn từ sapo_orders`);

      // ------------------------------------------ 4. order_items đổi tên cột
      const updItems = await ex(`
        UPDATE order_items SET
          name             = COALESCE(name, product_name),
          total_discount   = COALESCE(NULLIF(total_discount, 0), discount, 0),
          discounted_total = COALESCE(discounted_total, total, price * quantity, 0),
          current_quantity = COALESCE(current_quantity, quantity)`);
      console.log(`4. Chuẩn hoá ${updItems} dòng hàng`);

      // ------------------------------------------------------ 5. kiểm chứng
      console.log('\n--- KIỂM CHỨNG ---');
      const checks = [
        ['đơn còn lại', `SELECT count(*)::int n FROM orders`],
        ['thiếu name', `SELECT count(*)::int n FROM orders WHERE name IS NULL`],
        ['thiếu location_id', `SELECT count(*)::int n FROM orders WHERE location_id IS NULL`],
        ['thiếu user_id', `SELECT count(*)::int n FROM orders WHERE user_id IS NULL`],
        ['thiếu created_on', `SELECT count(*)::int n FROM orders WHERE created_on IS NULL`],
        ['đơn huỷ thiếu cancelled_on',
          `SELECT count(*)::int n FROM orders WHERE status='cancelled' AND cancelled_on IS NULL`],
        ['dòng hàng thiếu name', `SELECT count(*)::int n FROM order_items WHERE name IS NULL`],
      ];
      for (const [label, sql] of checks) {
        console.log(`  ${label}: ${(await qy(sql))[0].n}`);
      }
      console.log('  phân bố status:');
      console.table(await qy(`SELECT status::text, count(*)::int n FROM orders GROUP BY 1 ORDER BY 2 DESC`));
      console.log('  phân bố financial_status:');
      console.table(await qy(`SELECT financial_status::text, count(*)::int n FROM orders GROUP BY 1 ORDER BY 2 DESC`));
      console.log('  top kênh bán:');
      console.table(await qy(`SELECT source_name, count(*)::int n FROM orders GROUP BY 1 ORDER BY 2 DESC LIMIT 5`));
      console.log('  đơn theo kho:');
      console.table(await qy(`SELECT l.name kho, count(*)::int n FROM orders o
        LEFT JOIN locations l ON l.id=o.location_id GROUP BY 1 ORDER BY 2 DESC LIMIT 8`));

      if (!APPLY) throw ROLLBACK;
    },
    { timeout: 900000, maxWait: 60000 },
  );
  console.log(APPLY ? '\n✅ ĐÃ GHI THẬT' : '\n🔄 Dry-run — đã ROLLBACK, DB không đổi');
}

main()
  .catch((e) => {
    if (e === ROLLBACK) return;
    console.error('LỖI:', e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
