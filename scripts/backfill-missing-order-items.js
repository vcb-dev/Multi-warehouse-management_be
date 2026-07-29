/**
 * Kéo lại `line_items` cho những đơn đã đồng bộ nhưng KHÔNG có dòng hàng nào.
 * (Lần sync đơn gốc bỏ sót — đã kiểm chứng phiên bản đều tồn tại trong DB.)
 *
 * Chạy: node scripts/backfill-missing-order-items.js
 */
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const STORE = process.env.SAPO_STORE;
const AUTH = Buffer.from(
  `${process.env.SAPO_API_KEY}:${process.env.SAPO_API_SECRET}`,
).toString('base64');

async function api(path, tries = 4) {
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

(async () => {
  const empty = await prisma.$queryRawUnsafe(`
    SELECT id, name, sapo_id FROM orders o
    WHERE sapo_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id)`);
  console.log(`Đơn thiếu dòng hàng: ${empty.length}`);

  const variants = await prisma.productVariant.findMany({
    where: { sapoId: { not: null } },
    select: { id: true, sapoId: true },
  });
  const variantBySapo = new Map(variants.map((v) => [String(v.sapoId), v.id]));

  let fixed = 0;
  let lines = 0;
  let skippedNoVariant = 0;
  let stillEmpty = 0;

  for (const o of empty) {
    const j = await api(`/admin/orders/${o.sapo_id}.json`);
    const src = j.order?.line_items ?? [];

    const data = [];
    for (const l of src) {
      const variantId = variantBySapo.get(String(l.variant_id));
      if (!variantId) {
        skippedNoVariant += 1;
        continue;
      }
      data.push({
        orderId: o.id,
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
      });
    }

    if (!data.length) {
      stillEmpty += 1;
      console.log(`  ⚠ ${o.name}: Sapo cũng không có dòng hàng (${src.length} dòng gốc)`);
      continue;
    }

    await db(() =>
      prisma.$transaction(async (tx) => {
        await tx.orderItem.createMany({ data });
        // Đồng bộ lại tổng số lượng cho khớp dòng hàng vừa thêm
        await tx.order.update({
          where: { id: o.id },
          data: {
            subtotalLineItemsQuantity: data.reduce((s, d) => s + d.quantity, 0),
          },
        });
      }),
    );
    fixed += 1;
    lines += data.length;
    if (fixed % 20 === 0) console.log(`  ...${fixed}/${empty.length} đơn, ${lines} dòng`);
  }

  console.log(`\n=== KẾT QUẢ ===`);
  console.log(`đã bổ sung: ${fixed} đơn / ${lines} dòng hàng`);
  console.log(`bỏ qua: ${stillEmpty} đơn Sapo cũng rỗng, ${skippedNoVariant} dòng thiếu phiên bản`);

  await prisma.$disconnect();
})();
