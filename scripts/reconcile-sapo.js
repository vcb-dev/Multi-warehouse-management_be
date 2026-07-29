/**
 * Đối chiếu số liệu DB local với Sapo thật (chỉ đọc).
 * Chạy: node scripts/reconcile-sapo.js
 */
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const STORE = process.env.SAPO_STORE;
const AUTH = Buffer.from(
  `${process.env.SAPO_API_KEY}:${process.env.SAPO_API_SECRET}`,
).toString('base64');

async function api(path) {
  const res = await fetch(`https://${STORE}.mysapo.net${path}`, {
    headers: { Authorization: `Basic ${AUTH}` },
  });
  if (!res.ok) return null;
  return res.json();
}

const rows = [];
function cmp(name, sapo, local, note = '') {
  const diff = sapo === null ? null : local - sapo;
  rows.push({ name, sapo, local, diff, note });
  const mark = diff === null ? '  ?' : diff === 0 ? ' ✅' : ' ⚠';
  console.log(
    `${mark} ${name.padEnd(30)} Sapo=${String(sapo ?? 'n/a').padStart(7)}  local=${String(local).padStart(7)}` +
      (diff ? `  lệch=${diff > 0 ? '+' : ''}${diff}` : '') +
      (note ? `  (${note})` : ''),
  );
}

(async () => {
  console.log('=== ĐỐI CHIẾU SỐ LƯỢNG ===');
  const cCount = await api('/admin/customers/count.json');
  cmp('Khách hàng', cCount?.count ?? null, await prisma.customer.count());

  const oCount = await api('/admin/orders/count.json');
  cmp('Đơn hàng', oCount?.count ?? null, await prisma.order.count(), 'local có cả đơn tạo tại app');

  const pCount = await api('/admin/products/count.json');
  cmp('Sản phẩm', pCount?.count ?? null, await prisma.product.count());

  const lRes = await api('/admin/locations.json?limit=250');
  cmp('Kho/chi nhánh', lRes?.locations?.length ?? null, await prisma.location.count());

  const gRes = await api('/admin/customer_groups.json?limit=250');
  cmp('Nhóm khách', gRes?.customer_groups?.length ?? null, await prisma.customerGroup.count(),
    'local có thêm nhóm nội bộ');

  console.log('\n=== ĐỐI CHIẾU TRẠNG THÁI ĐƠN (chỉ đơn đã đồng bộ) ===');
  for (const st of ['open', 'closed', 'cancelled']) {
    const s = await api(`/admin/orders/count.json?status=${st}`);
    const l = await prisma.order.count({ where: { status: st, sapoId: { not: null } } });
    cmp(`  status=${st}`, s?.count ?? null, l);
  }
  for (const fs of ['fulfilled', 'partial']) {
    const s = await api(`/admin/orders/count.json?fulfillment_status=${fs}`);
    const l = await prisma.order.count({
      where: { fulfillmentStatus: fs, sapoId: { not: null } },
    });
    cmp(`  fulfillment=${fs}`, s?.count ?? null, l);
  }
  for (const fs of ['paid', 'pending', 'refunded']) {
    const s = await api(`/admin/orders/count.json?financial_status=${fs}`);
    const l = await prisma.order.count({
      where: { financialStatus: fs, sapoId: { not: null } },
    });
    cmp(`  financial=${fs}`, s?.count ?? null, l);
  }

  console.log('\n=== ĐỐI CHIẾU CHI TIẾT 20 ĐƠN NGẪU NHIÊN ===');
  const sample = await prisma.$queryRawUnsafe(`
    SELECT id, sapo_id, name, status, financial_status, fulfillment_status,
           total_price, subtotal_line_items_quantity
    FROM orders WHERE sapo_id IS NOT NULL ORDER BY random() LIMIT 20`);

  const fields = [
    ['name', (o) => o.name, (x) => x.name],
    ['status', (o) => o.status, (x) => x.status],
    ['financial_status', (o) => o.financial_status, (x) => x.financial_status],
    ['fulfillment_status', (o) => o.fulfillment_status, (x) => x.fulfillment_status ?? null],
    ['total_price', (o) => Number(o.total_price), (x) => Number(x.total_price)],
    ['số lượng', (o) => o.subtotal_line_items_quantity, (x) => x.subtotal_line_items_quantity],
  ];
  const mismatch = {};
  let checked = 0;
  for (const o of sample) {
    const j = await api(`/admin/orders/${o.sapo_id}.json`);
    if (!j?.order) continue;
    checked += 1;
    for (const [label, getLocal, getSapo] of fields) {
      const a = getLocal(o);
      const b = getSapo(j.order);
      if (String(a ?? '') !== String(b ?? '')) {
        mismatch[label] = (mismatch[label] || 0) + 1;
        if ((mismatch[label] ?? 0) <= 2) {
          console.log(`  ⚠ ${o.name} · ${label}: local=${a} ≠ sapo=${b}`);
        }
      }
    }
    // số dòng hàng
    const localLines = await prisma.orderItem.count({ where: { orderId: o.id } });
    const sapoLines = (j.order.line_items ?? []).length;
    if (localLines !== sapoLines) {
      mismatch['số dòng hàng'] = (mismatch['số dòng hàng'] || 0) + 1;
      console.log(`  ⚠ ${o.name} · số dòng hàng: local=${localLines} ≠ sapo=${sapoLines}`);
    }
  }
  console.log(`  Đã đối chiếu ${checked} đơn.`);
  if (Object.keys(mismatch).length === 0) {
    console.log('  ✅ Không trường nào lệch.');
  } else {
    console.log('  Tổng hợp lệch:', JSON.stringify(mismatch));
  }

  console.log('\n=== TỔNG HỢP ===');
  const bad = rows.filter((r) => r.diff !== null && r.diff !== 0);
  console.log(`${rows.length - bad.length}/${rows.length} chỉ số khớp tuyệt đối.`);
  bad.forEach((r) => console.log(`  ⚠ ${r.name}: lệch ${r.diff > 0 ? '+' : ''}${r.diff}`));

  await prisma.$disconnect();
})();
