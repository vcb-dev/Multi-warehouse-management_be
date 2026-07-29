/**
 * Backfill các trường số lượng theo dòng hàng từ Sapo (`current_quantity`,
 * `fulfillable_quantity`, `non_fulfillable_quantity`, `refundable_quantity`)
 * rồi tính lại `orders.subtotal_line_items_quantity` = Σ current_quantity.
 *
 * Lý do: Sapo tính `subtotal_line_items_quantity` theo số lượng CÒN LẠI sau khi
 * huỷ/hoàn, không phải số đặt ban đầu. Vd HK32305: 3 dòng ×1, huỷ 1 dòng ->
 * Sapo trả 2, ta đang lưu 3.
 *
 * Chạy: node scripts/backfill-line-item-quantities.js [--apply]
 *
 * Khớp dòng local ↔ Sapo theo VỊ TRÍ (order_items.id tăng dần ↔ thứ tự
 * line_items) vì có 594 cặp (đơn, phiên bản) xuất hiện nhiều hơn 1 dòng nên
 * khớp theo variant_id sẽ nhập nhằng. Chỉ khớp khi số dòng hai bên bằng nhau.
 */
require('dotenv').config({ quiet: true });
const { PrismaClient, Prisma } = require('@prisma/client');

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const STORE = process.env.SAPO_STORE;
const AUTH = Buffer.from(
  `${process.env.SAPO_API_KEY}:${process.env.SAPO_API_SECRET}`,
).toString('base64');

async function api(path, tries = 5) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(`https://${STORE}.mysapo.net${path}`, {
        headers: { Authorization: `Basic ${AUTH}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === tries) throw e;
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
}

async function db(fn, tries = 5) {
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!['P1017', 'P1001', 'P2024'].includes(e.code) || i === tries) throw e;
      console.warn(`  ⚠ mất kết nối (${e.code}), thử lại lần ${i}...`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

const stats = {
  orders: 0,
  lines: 0,
  skipCountMismatch: 0,
  skipNoLocal: 0,
  ordersQtyChanged: 0,
};

async function flushLines(rows) {
  if (!rows.length) return;
  const values = rows.map(
    (r) => Prisma.sql`(${r.id}::bigint, ${r.cur}::int, ${r.ful}::int, ${r.non}::int, ${r.ref}::int)`,
  );
  await db(() =>
    prisma.$executeRaw`
      UPDATE order_items AS t SET
        current_quantity = v.cur,
        fulfillable_quantity = v.ful,
        non_fulfillable_quantity = v.non,
        refundable_quantity = v.ref
      FROM (VALUES ${Prisma.join(values)}) AS v(id, cur, ful, non, ref)
      WHERE t.id = v.id`,
  );
}

async function flushOrders(rows) {
  if (!rows.length) return;
  const values = rows.map((r) => Prisma.sql`(${r.id}::bigint, ${r.qty}::int)`);
  await db(() =>
    prisma.$executeRaw`
      UPDATE orders AS t SET subtotal_line_items_quantity = v.qty
      FROM (VALUES ${Prisma.join(values)}) AS v(id, qty)
      WHERE t.id = v.id`,
  );
}

(async () => {
  const first = await prisma.order.findFirst({
    where: { sapoId: { not: null } },
    orderBy: { createdOn: 'asc' },
    select: { createdOn: true },
  });
  const start = new Date(first?.createdOn ?? '2025-01-01');
  start.setDate(1);
  start.setHours(0, 0, 0, 0);

  for (let d = new Date(start); d <= new Date(); d.setMonth(d.getMonth() + 1)) {
    const from = new Date(d);
    const to = new Date(d);
    to.setMonth(to.getMonth() + 1);
    const label = from.toISOString().slice(0, 7);

    let page = 1;
    while (page * 250 <= 30000) {
      const j = await api(
        `/admin/orders.json?limit=250&page=${page}` +
          `&created_on_min=${from.toISOString()}&created_on_max=${to.toISOString()}`,
      );
      const list = j.orders ?? [];
      if (!list.length) break;

      // Nạp dòng hàng local của cả trang trong 1 truy vấn
      const sapoIds = list.map((o) => BigInt(o.id));
      const locals = await db(() =>
        prisma.order.findMany({
          where: { sapoId: { in: sapoIds } },
          select: {
            id: true,
            sapoId: true,
            subtotalLineItemsQuantity: true,
            items: { select: { id: true }, orderBy: { id: 'asc' } },
          },
        }),
      );
      const localBySapo = new Map(locals.map((o) => [String(o.sapoId), o]));

      const lineRows = [];
      const orderRows = [];
      for (const o of list) {
        const local = localBySapo.get(String(o.id));
        if (!local) {
          stats.skipNoLocal += 1;
          continue;
        }
        const src = o.line_items ?? [];
        if (src.length !== local.items.length) {
          stats.skipCountMismatch += 1;
          continue;
        }

        let sumCurrent = 0;
        src.forEach((l, idx) => {
          const cur = l.current_quantity ?? l.quantity ?? 0;
          sumCurrent += cur;
          lineRows.push({
            id: local.items[idx].id,
            cur,
            ful: l.fulfillable_quantity ?? 0,
            non: l.non_fulfillable_quantity ?? 0,
            ref: l.refundable_quantity ?? 0,
          });
        });
        stats.orders += 1;
        stats.lines += src.length;

        const sapoQty = o.subtotal_line_items_quantity ?? sumCurrent;
        if (local.subtotalLineItemsQuantity !== sapoQty) {
          stats.ordersQtyChanged += 1;
          orderRows.push({ id: local.id, qty: sapoQty });
        }
      }

      if (APPLY) {
        for (let i = 0; i < lineRows.length; i += 500) {
          await flushLines(lineRows.slice(i, i + 500));
        }
        for (let i = 0; i < orderRows.length; i += 500) {
          await flushOrders(orderRows.slice(i, i + 500));
        }
      }

      if (list.length < 250) break;
      page += 1;
    }
    console.log(
      `  ${label}: ${stats.orders} đơn, ${stats.lines} dòng, ${stats.ordersQtyChanged} đơn đổi số lượng`,
    );
  }

  console.log('\n=== KẾT QUẢ ===');
  console.log(`đơn xử lý       : ${stats.orders}`);
  console.log(`dòng cập nhật   : ${stats.lines}`);
  console.log(`đơn đổi số lượng: ${stats.ordersQtyChanged}`);
  console.log(`bỏ qua          : ${stats.skipCountMismatch} đơn lệch số dòng, ${stats.skipNoLocal} đơn chưa có local`);
  if (!APPLY) console.log('\n(chạy lại với --apply để ghi)');

  await prisma.$disconnect();
})();
