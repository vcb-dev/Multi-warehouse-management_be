/**
 * Kéo `order.refunds[]` (hoàn tiền / trả hàng / huỷ đơn) từ Sapo về
 * `order_refunds` + `order_refund_items`, và tạo `order_returns` cho các
 * refund có `return_id`.
 *
 * Chạy: node scripts/backfill-sapo-refunds.js
 *
 * Lấy qua endpoint danh sách (refunds nằm lồng trong order) + cửa sổ theo tháng
 * — nhanh hơn hàng chục lần so với gọi từng đơn một.
 *
 * KHÔNG ghi đè `return_status`/`refund_status`/`restock_status` của đơn: các giá
 * trị đó đã backfill trực tiếp từ Sapo ở Phase 3 và là nguồn chuẩn. Script chỉ
 * đối chiếu rồi báo số lệch ở cuối.
 */
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
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

const toDate = (v) => (v ? new Date(v) : null);

/** Pooler của Supabase hay đóng kết nối giữa chừng (P1017) — thử lại có lùi dần. */
async function db(fn, tries = 5) {
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      const retryable = ['P1017', 'P1001', 'P2024'].includes(e.code);
      if (!retryable || i === tries) throw e;
      console.warn(`  ⚠ mất kết nối (${e.code}), thử lại lần ${i}...`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

/** Sapo `restock_type` -> enum RestockType của dự án */
function mapRestockType(t) {
  if (t === 'cancel') return 'cancel';
  if (t === 'return' || t === 'return_item') return 'return_item';
  return 'no_restock';
}

async function loadMaps() {
  const [orders, locations, variants, users] = await Promise.all([
    prisma.order.findMany({
      where: { sapoId: { not: null } },
      select: { id: true, sapoId: true },
    }),
    prisma.location.findMany({
      where: { sapoId: { not: null } },
      select: { id: true, sapoId: true },
    }),
    prisma.productVariant.findMany({
      where: { sapoId: { not: null } },
      select: { id: true, sapoId: true },
    }),
    prisma.user.findFirst({ select: { id: true } }),
  ]);
  return {
    orderBySapo: new Map(orders.map((o) => [String(o.sapoId), o.id])),
    locationBySapo: new Map(locations.map((l) => [String(l.sapoId), l.id])),
    variantBySapo: new Map(variants.map((v) => [String(v.sapoId), v.id])),
    fallbackUserId: users.id,
    defaultLocationId: locations[0]?.id,
  };
}

async function importWindow(query, label, maps, stats) {
  let page = 1;
  while (page * 250 <= 30000) {
    const j = await api(`/admin/orders.json?limit=250&page=${page}${query}`);
    const list = j.orders ?? [];
    if (!list.length) break;

    // Gom trước dòng hàng + refund đã có của CẢ trang (2 truy vấn thay vì 2/đơn)
    const withRefunds = list.filter((o) => (o.refunds ?? []).length);
    const localIds = withRefunds
      .map((o) => maps.orderBySapo.get(String(o.id)))
      .filter(Boolean);
    const allItems = localIds.length
      ? await db(() =>
          prisma.orderItem.findMany({
            where: { orderId: { in: localIds } },
            select: { id: true, orderId: true, variantId: true },
          }),
        )
      : [];
    const itemsByOrder = new Map();
    for (const it of allItems) {
      const key = String(it.orderId);
      if (!itemsByOrder.has(key)) itemsByOrder.set(key, new Map());
      itemsByOrder.get(key).set(String(it.variantId), it.id);
    }
    const refundSapoIds = withRefunds.flatMap((o) =>
      (o.refunds ?? []).map((r) => BigInt(r.id)),
    );
    const existingRefunds = refundSapoIds.length
      ? new Set(
          (
            await db(() =>
              prisma.orderRefund.findMany({
                where: { sapoId: { in: refundSapoIds } },
                select: { sapoId: true },
              }),
            )
          ).map((r) => String(r.sapoId)),
        )
      : new Set();

    for (const o of withRefunds) {
      const refunds = o.refunds ?? [];
      const localOrderId = maps.orderBySapo.get(String(o.id));
      if (!localOrderId) {
        stats.skippedNoOrder += 1;
        continue;
      }
      const itemByVariant = itemsByOrder.get(String(localOrderId)) ?? new Map();

      for (const rf of refunds) {
        if (existingRefunds.has(String(rf.id))) {
          stats.already += 1;
          continue;
        }

        // Refund gắn phiếu trả hàng -> tạo/tìm order_return theo sapo return_id
        let returnId = null;
        if (rf.return_id) {
          const existing = await db(() =>
            prisma.orderReturn.findUnique({
              where: { sapoId: BigInt(rf.return_id) },
            }),
          );
          returnId = existing
            ? existing.id
            : (
                await db(() =>
                  prisma.orderReturn.create({
                  data: {
                    sapoId: BigInt(rf.return_id),
                    code: `RT-SAPO-${rf.return_id}`,
                    orderId: localOrderId,
                    reason: rf.note || null,
                    createdById: maps.fallbackUserId,
                    createdOn: toDate(rf.created_on) ?? new Date(),
                  },
                  }),
                )
              ).id;
          if (!existing) stats.returns += 1;
        }

        const lines = [];
        for (const l of rf.refund_line_items ?? []) {
          const li = l.line_item ?? {};
          const variantId = maps.variantBySapo.get(String(li.variant_id));
          if (!variantId) {
            stats.skippedNoVariant += 1;
            continue;
          }
          const locationId =
            maps.locationBySapo.get(String(l.location_id)) ?? maps.defaultLocationId;
          lines.push({
            sapoId: BigInt(l.id),
            // order_items không có sapo_id nên khớp theo variant trong cùng đơn
            orderItemId: itemByVariant.get(String(variantId)) ?? null,
            variantId,
            locationId,
            productName: li.name || li.title || '',
            sku: li.sku || '',
            variantTitle: li.variant_title || null,
            quantity: l.quantity ?? 0,
            price: String(li.price ?? 0),
            subtotal: String(l.subtotal ?? 0),
            totalTax: String(l.total_tax ?? 0),
            restockType: mapRestockType(l.restock_type),
          });
        }

        await db(() =>
          prisma.orderRefund.create({
          data: {
            sapoId: BigInt(rf.id),
            orderId: localOrderId,
            returnId,
            note: rf.note || null,
            restock: !!rf.restock,
            totalRefunded: String(rf.total_refunded ?? 0),
            processedAt: toDate(rf.processed_at) ?? toDate(rf.created_on) ?? new Date(),
            createdById: maps.fallbackUserId,
            createdOn: toDate(rf.created_on) ?? new Date(),
            lineItems: { create: lines },
          },
          }),
        );
        stats.refunds += 1;
        stats.lines += lines.length;
      }
    }

    if (page % 10 === 0 || list.length < 250) {
      console.log(
        `  ${label} trang ${page}: ${stats.refunds} refund, ${stats.lines} dòng, ${stats.returns} phiếu trả`,
      );
    }
    if (list.length < 250) break;
    page += 1;
  }
}

(async () => {
  const maps = await loadMaps();
  console.log(
    `Map: ${maps.orderBySapo.size} đơn, ${maps.variantBySapo.size} phiên bản, ${maps.locationBySapo.size} kho`,
  );

  const first = await prisma.order.findFirst({
    where: { sapoId: { not: null } },
    orderBy: { createdOn: 'asc' },
    select: { createdOn: true },
  });
  const start = new Date(first?.createdOn ?? '2025-01-01');
  start.setDate(1);
  start.setHours(0, 0, 0, 0);

  const stats = {
    refunds: 0,
    lines: 0,
    returns: 0,
    already: 0,
    skippedNoOrder: 0,
    skippedNoVariant: 0,
  };

  for (let d = new Date(start); d <= new Date(); d.setMonth(d.getMonth() + 1)) {
    const from = new Date(d);
    const to = new Date(d);
    to.setMonth(to.getMonth() + 1);
    await importWindow(
      `&created_on_min=${from.toISOString()}&created_on_max=${to.toISOString()}`,
      from.toISOString().slice(0, 7),
      maps,
      stats,
    );
  }

  console.log('\n=== KẾT QUẢ ===');
  console.log(`refunds: ${stats.refunds} | dòng: ${stats.lines} | phiếu trả hàng: ${stats.returns}`);
  console.log(
    `bỏ qua: ${stats.already} đã có, ${stats.skippedNoOrder} không thấy đơn, ${stats.skippedNoVariant} không thấy phiên bản`,
  );

  await prisma.$disconnect();
})();
