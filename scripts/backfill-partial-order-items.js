/**
 * Kéo lại các DÒNG HÀNG BỊ THIẾU của đơn đã đồng bộ một phần.
 *
 * Khác `backfill-missing-order-items.js` (chỉ xử lý đơn KHÔNG có dòng nào):
 * ở đây đơn có dòng nhưng thiếu một vài dòng so với Sapo, biểu hiện là
 * `subtotal_line_items_quantity` lớn hơn tổng số lượng dòng đang lưu.
 *
 * `order_items` không lưu id dòng của Sapo nên khớp theo bộ ba
 * (variant sapo_id, quantity, price) dạng multiset — đủ phân biệt vì trùng cả
 * ba thì hai dòng là tương đương về mọi mặt báo cáo.
 *
 * Chạy thử:  node scripts/backfill-partial-order-items.js
 * Ghi thật:  node scripts/backfill-partial-order-items.js --apply
 */
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');

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

const key = (variantSapoId, qty, price) =>
  `${variantSapoId}|${qty}|${Number(price)}`;

function lineData(l, orderId, variantId) {
  return {
    orderId,
    variantId,
    productId: l.product_id ? BigInt(l.product_id) : null,
    inventoryItemId: l.inventory_item_id ? BigInt(l.inventory_item_id) : null,
    name: l.name || l.title || '',
    variantTitle: l.variant_title || null,
    sku: l.sku || '',
    quantity: l.quantity ?? 0,
    price: String(l.price ?? 0),
    totalDiscount: String(l.total_discount ?? 0),
    discountedTotal: String(l.discounted_total ?? 0),
    originalTotal: l.original_total != null ? String(l.original_total) : null,
    fulfillableQuantity: l.fulfillable_quantity ?? null,
    currentQuantity: l.current_quantity ?? null,
    nonFulfillableQuantity: l.non_fulfillable_quantity ?? null,
    refundableQuantity: l.refundable_quantity ?? null,
    grams: l.grams ?? null,
    taxable: l.taxable ?? true,
    requiresShipping: l.requires_shipping ?? true,
    restockable: l.restockable ?? true,
  };
}

(async () => {
  console.log(APPLY ? '>>> CHẾ ĐỘ GHI THẬT' : '>>> chạy thử, không ghi gì');

  // Đơn có dòng, không có dòng nào bị huỷ, mà header vẫn lớn hơn Σ quantity.
  const suspects = await prisma.$queryRawUnsafe(`
    WITH t AS (
      SELECT o.id, o.sapo_id, o.name,
             o.subtotal_line_items_quantity ghi,
             SUM(i.quantity)::int sum_qty,
             count(*) FILTER (WHERE i.current_quantity IS DISTINCT FROM i.quantity)::int dong_huy
      FROM orders o JOIN order_items i ON i.order_id = o.id
      GROUP BY o.id, o.sapo_id, o.name, o.subtotal_line_items_quantity)
    SELECT id, sapo_id, name, ghi, sum_qty FROM t
    WHERE ghi <> sum_qty AND dong_huy = 0 AND sapo_id IS NOT NULL
    ORDER BY id`);

  console.log(`Đơn nghi thiếu dòng: ${suspects.length}\n`);

  const variants = await prisma.productVariant.findMany({
    where: { sapoId: { not: null } },
    select: { id: true, sapoId: true },
  });
  const varBySapo = new Map(variants.map((v) => [String(v.sapoId), v.id]));

  let themDong = 0;
  let donSua = 0;
  let boQua = 0;
  const thieuVariant = [];

  for (const o of suspects) {
    const j = await api(`/admin/orders/${o.sapo_id}.json`);
    const sapoLines = j.order?.line_items ?? [];

    const local = await prisma.orderItem.findMany({
      where: { orderId: o.id },
      select: { quantity: true, price: true, variant: { select: { sapoId: true } } },
    });

    const localCount = new Map();
    for (const l of local) {
      const k = key(l.variant.sapoId ?? 'null', l.quantity, l.price);
      localCount.set(k, (localCount.get(k) ?? 0) + 1);
    }

    const missing = [];
    for (const sl of sapoLines) {
      const k = key(sl.variant_id, sl.quantity ?? 0, sl.price ?? 0);
      const have = localCount.get(k) ?? 0;
      if (have > 0) {
        localCount.set(k, have - 1);
        continue;
      }
      missing.push(sl);
    }

    if (!missing.length) {
      boQua += 1;
      console.log(`  ${o.name}: Sapo không có dòng nào thừa ra — bỏ qua`);
      continue;
    }

    const rows = [];
    for (const sl of missing) {
      const variantId = varBySapo.get(String(sl.variant_id));
      if (!variantId) {
        thieuVariant.push({ order: o.name, variant_sapo_id: sl.variant_id, sku: sl.sku });
        continue;
      }
      rows.push(lineData(sl, o.id, variantId));
    }

    console.log(
      `  ${o.name}: local ${local.length} dòng (Σ${o.sum_qty}), header ${o.ghi}, ` +
        `Sapo ${sapoLines.length} dòng → thêm ${rows.length}` +
        (rows.length ? `: ${rows.map((r) => `${r.sku}×${r.quantity}`).join(', ')}` : ''),
    );

    if (rows.length && APPLY) {
      await prisma.orderItem.createMany({ data: rows });
    }
    if (rows.length) {
      themDong += rows.length;
      donSua += 1;
    }
  }

  console.log(`\nKẾT QUẢ`);
  console.log(`  đơn sẽ sửa:        ${donSua}`);
  console.log(`  dòng sẽ thêm:      ${themDong}`);
  console.log(`  đơn bỏ qua:        ${boQua}`);
  console.log(`  dòng thiếu variant: ${thieuVariant.length}`);
  for (const t of thieuVariant) {
    console.log(`    ${t.order}: variant Sapo ${t.variant_sapo_id} (${t.sku}) chưa có trong DB`);
  }

  console.log(
    APPLY ? '\nĐã ghi.' : '\nChưa ghi gì. Thêm --apply để thêm dòng hàng.',
  );
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
