/**
 * Làm mới trạng thái + số tiền + mốc thời gian cho những đơn ĐÃ đồng bộ.
 *
 * Khác `sync-new-sapo-orders.js` (chỉ tạo đơn mới): script này cập nhật đơn đã
 * có, vì Sapo vẫn tiếp tục đổi trạng thái sau lần backfill (vd đơn từng
 * `closed` bị mở lại thành `open`).
 *
 * Chạy: node scripts/refresh-order-statuses.js [--apply] [--from=ISO]
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

const toDate = (v) => (v ? new Date(v) : null);
const pick = (v, allowed, fb) => (allowed.includes(v) ? v : fb);
const STATUS = ['open', 'closed', 'cancelled'];
const FIN = ['pending', 'partially_paid', 'paid', 'refunded', 'partially_refunded'];
const FUL = ['partial', 'fulfilled'];
const RET = ['no_return', 'in_progress', 'returned'];
const REF = ['no_refund', 'refunded', 'partial'];
const RESTOCK = ['no_restock', 'restocked', 'partial'];

(async () => {
  const argFrom = process.argv.find((a) => a.startsWith('--from='));
  const first = await prisma.order.findFirst({
    where: { sapoId: { not: null } },
    orderBy: { createdOn: 'asc' },
    select: { createdOn: true },
  });
  const start = argFrom
    ? new Date(argFrom.slice('--from='.length))
    : new Date(first?.createdOn ?? '2025-01-01');
  start.setDate(1);
  start.setHours(0, 0, 0, 0);

  let checked = 0;
  let changed = 0;
  const changedBy = {};

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

      const sapoIds = list.map((o) => BigInt(o.id));
      const locals = await db(() =>
        prisma.order.findMany({
          where: { sapoId: { in: sapoIds } },
          select: {
            id: true,
            sapoId: true,
            status: true,
            financialStatus: true,
            fulfillmentStatus: true,
            returnStatus: true,
            refundStatus: true,
            restockStatus: true,
            totalReceived: true,
          },
        }),
      );
      const byS = new Map(locals.map((o) => [String(o.sapoId), o]));

      const rows = [];
      for (const o of list) {
        const local = byS.get(String(o.id));
        if (!local) continue;
        checked += 1;

        const next = {
          status: pick(o.status, STATUS, 'open'),
          financialStatus: pick(o.financial_status, FIN, 'pending'),
          fulfillmentStatus: FUL.includes(o.fulfillment_status) ? o.fulfillment_status : null,
          returnStatus: pick(o.return_status, RET, 'no_return'),
          refundStatus: pick(o.refund_status, REF, 'no_refund'),
          restockStatus: RESTOCK.includes(o.restock_status) ? o.restock_status : null,
          totalReceived: String(o.total_received ?? 0),
        };
        const diffs = Object.keys(next).filter(
          (k) => String(local[k] ?? '') !== String(next[k] ?? ''),
        );
        if (!diffs.length) continue;
        diffs.forEach((k) => (changedBy[k] = (changedBy[k] || 0) + 1));
        changed += 1;

        rows.push(
          Prisma.sql`(${local.id}::bigint,
            ${next.status}::"OrderStatus",
            ${next.financialStatus}::"OrderFinancialStatus",
            ${next.fulfillmentStatus}::"OrderFulfillmentStatus",
            ${next.returnStatus}::"OrderReturnStatus",
            ${next.refundStatus}::"OrderRefundStatus",
            ${next.restockStatus}::"OrderRestockStatus",
            ${next.totalReceived}::decimal,
            ${toDate(o.cancelled_on)}::timestamp,
            ${toDate(o.closed_on)}::timestamp,
            ${toDate(o.completed_on)}::timestamp,
            ${toDate(o.paid_on)}::timestamp,
            ${toDate(o.delivered_on)}::timestamp)`,
        );
      }

      if (APPLY && rows.length) {
        for (let i = 0; i < rows.length; i += 300) {
          const chunk = rows.slice(i, i + 300);
          await db(() =>
            prisma.$executeRaw`
              UPDATE orders AS t SET
                status = v.status,
                financial_status = v.fin,
                fulfillment_status = v.ful,
                return_status = v.ret,
                refund_status = v.ref,
                restock_status = v.restock,
                total_received = v.received,
                cancelled_on = v.cancelled_on,
                closed_on = v.closed_on,
                completed_on = v.completed_on,
                paid_on = v.paid_on,
                delivered_on = v.delivered_on
              FROM (VALUES ${Prisma.join(chunk)}) AS v(id, status, fin, ful, ret, ref,
                restock, received, cancelled_on, closed_on, completed_on, paid_on, delivered_on)
              WHERE t.id = v.id`,
          );
        }
      }

      if (list.length < 250) break;
      page += 1;
    }
    console.log(`  ${label}: đã rà ${checked}, cần đổi ${changed}`);
  }

  console.log('\n=== KẾT QUẢ ===');
  console.log(`đơn đã rà : ${checked}`);
  console.log(`đơn đổi   : ${changed}`);
  console.log('theo trường:', JSON.stringify(changedBy));
  if (!APPLY) console.log('\n(chạy lại với --apply để ghi)');

  await prisma.$disconnect();
})();
