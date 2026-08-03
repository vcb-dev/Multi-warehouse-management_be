/**
 * 18 đơn có `orders.sapo_id` nhưng thiếu dòng tương ứng trong bảng staging `sapo_orders`
 * (lô sync cuối ngày 24/07 chưa kịp vào staging). Kéo từng đơn từ Sapo về và chèn vào
 * `sapo_orders` để bước backfill chính xử lý chúng đồng nhất như 87.893 đơn còn lại.
 *
 * Chạy:  set -a && . ./.env && set +a && node scripts-tmp/fetch-missing-sapo-orders.js [--apply]
 */
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
});
const STORE = process.env.SAPO_STORE;
const AUTH = Buffer.from(
  `${process.env.SAPO_API_KEY}:${process.env.SAPO_API_SECRET}`,
).toString('base64');

async function api(path, tries = 5) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(`https://${STORE}.mysapo.net${path}`, {
        headers: { Authorization: `Basic ${AUTH}` },
        signal: AbortSignal.timeout(60000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === tries) throw e;
      await new Promise((s) => setTimeout(s, 1500 * i));
    }
  }
}

const d = (v) => (v ? new Date(v) : null);
const num = (v) => (v == null ? null : Number(v));

async function main() {
  const missing = await prisma.$queryRawUnsafe(`
    SELECT o.sapo_id::text AS sapo_id FROM orders o
    WHERE o.sapo_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM sapo_orders s WHERE s.sapo_id = o.sapo_id)`);
  console.log(`${missing.length} đơn cần kéo về`);

  const rows = [];
  for (const m of missing) {
    const { order: o } = await api(`/admin/orders/${m.sapo_id}.json`);
    if (!o) {
      console.warn(`  ⚠ Sapo không trả đơn ${m.sapo_id}`);
      continue;
    }
    rows.push(o);
    console.log(`  ✓ ${o.name} (${o.status}/${o.financial_status}) location=${o.location_id}`);
  }

  if (!APPLY) {
    console.log('\n🔄 Dry-run — chưa ghi. Thêm --apply để chèn vào sapo_orders');
    return;
  }

  for (const o of rows) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO sapo_orders (
         sapo_id, code, order_number, sapo_status, financial_status, fulfillment_status,
         gateway, source_name, currency, email, phone, note, tags, cancel_reason,
         customer_sapo_id, customer_name, subtotal_price, total_line_items_price,
         total_discounts, total_tax, total_shipping_price, total_price, total_outstanding,
         unpaid_amount, total_received, total_refunded, item_quantity,
         created_on, modified_on, paid_on, cancelled_on, closed_on, expected_delivery_date,
         ship_name, ship_phone, ship_address1, ship_ward, ship_district, ship_city,
         ship_province, ship_country, synced_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
         $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,
         $39,$40,$41, now()
       ) ON CONFLICT (sapo_id) DO NOTHING`,
      BigInt(o.id), o.name, o.order_number ?? null, o.status ?? null,
      o.financial_status ?? null, o.fulfillment_status ?? null, o.gateway ?? null,
      o.source_name ?? null, o.currency ?? 'VND', o.email ?? null, o.phone ?? null,
      o.note ?? null,
      Array.isArray(o.tags) ? o.tags : o.tags ? String(o.tags).split(',').map((t) => t.trim()) : [],
      o.cancel_reason ?? null,
      o.customer?.id ? BigInt(o.customer.id) : null,
      o.customer ? [o.customer.first_name, o.customer.last_name].filter(Boolean).join(' ') : null,
      num(o.subtotal_price), num(o.total_line_items_price), num(o.total_discounts),
      num(o.total_tax), num(o.total_shipping_price), num(o.total_price),
      num(o.total_outstanding), num(o.unpaid_amount), num(o.total_received),
      num(o.total_refunded), o.subtotal_line_items_quantity ?? null,
      d(o.created_on), d(o.modified_on), d(o.paid_on), d(o.cancelled_on), d(o.closed_on),
      d(o.expected_delivery_date),
      o.shipping_address?.name ?? null, o.shipping_address?.phone ?? null,
      o.shipping_address?.address1 ?? null, o.shipping_address?.ward ?? null,
      o.shipping_address?.district ?? null, o.shipping_address?.city ?? null,
      o.shipping_address?.province ?? null, o.shipping_address?.country ?? null,
    );
  }
  console.log(`\n✅ Đã chèn ${rows.length} đơn vào sapo_orders`);
}

main()
  .catch((e) => {
    console.error('LỖI:', e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
