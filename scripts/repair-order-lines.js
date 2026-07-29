/**
 * Rà mọi đơn đã đồng bộ trong khoảng thời gian chỉ định, so số dòng hàng với
 * Sapo và bổ sung dòng còn thiếu. Cũng tạo luôn đơn Sapo có mà DB chưa có.
 *
 * Chạy: node scripts/repair-order-lines.js <ISO-from> [--apply]
 * Vd  : node scripts/repair-order-lines.js 2026-07-24T00:00:00Z --apply
 */
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const FROM = process.argv[2];
const STORE = process.env.SAPO_STORE;
const AUTH = Buffer.from(
  `${process.env.SAPO_API_KEY}:${process.env.SAPO_API_SECRET}`,
).toString('base64');

if (!FROM) {
  console.error('Thiếu tham số thời gian bắt đầu, vd: 2026-07-24T00:00:00Z');
  process.exit(1);
}

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

function lineData(l, variantId) {
  return {
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
  const variants = await prisma.productVariant.findMany({
    where: { sapoId: { not: null } },
    select: { id: true, sapoId: true },
  });
  const varBySapo = new Map(variants.map((v) => [String(v.sapoId), v.id]));

  let page = 1;
  let checked = 0;
  let repaired = 0;
  let addedLines = 0;
  let stillMissingVariant = 0;
  const missingOrders = [];

  while (page * 250 <= 30000) {
    const j = await api(`/admin/orders.json?limit=250&page=${page}&created_on_min=${FROM}`);
    const list = j.orders ?? [];
    if (!list.length) break;

    for (const o of list) {
      checked += 1;
      const local = await prisma.order.findUnique({
        where: { sapoId: BigInt(o.id) },
        select: { id: true, name: true, items: { select: { variantId: true } } },
      });
      if (!local) {
        missingOrders.push(o.name);
        continue;
      }

      // Đếm số dòng cần có theo từng variant (đơn có thể lặp variant)
      const need = new Map();
      for (const l of o.line_items ?? []) {
        const vid = varBySapo.get(String(l.variant_id));
        if (!vid) {
          stillMissingVariant += 1;
          continue;
        }
        if (!need.has(String(vid))) need.set(String(vid), []);
        need.get(String(vid)).push(l);
      }
      const have = new Map();
      for (const it of local.items) {
        have.set(String(it.variantId), (have.get(String(it.variantId)) ?? 0) + 1);
      }

      const toAdd = [];
      for (const [vid, lines] of need) {
        const already = have.get(vid) ?? 0;
        for (let i = already; i < lines.length; i++) {
          toAdd.push(lineData(lines[i], BigInt(vid)));
        }
      }
      if (!toAdd.length) continue;

      if (APPLY) {
        await prisma.$transaction(async (tx) => {
          await tx.orderItem.createMany({
            data: toAdd.map((d) => ({ ...d, orderId: local.id })),
          });
          await tx.order.update({
            where: { id: local.id },
            data: {
              subtotalLineItemsQuantity:
                o.subtotal_line_items_quantity ??
                (o.line_items ?? []).reduce((s, l) => s + (l.quantity ?? 0), 0),
            },
          });
        });
      }
      repaired += 1;
      addedLines += toAdd.length;
      console.log(`  ${APPLY ? '✅' : '·'} ${local.name}: +${toAdd.length} dòng`);
    }

    if (list.length < 250) break;
    page += 1;
  }

  console.log('\n=== KẾT QUẢ ===');
  console.log(`đơn đã rà      : ${checked}`);
  console.log(`đơn bổ sung dòng: ${repaired} (+${addedLines} dòng)`);
  console.log(`dòng vẫn thiếu phiên bản: ${stillMissingVariant}`);
  console.log(`đơn Sapo chưa có trong DB: ${missingOrders.length}${missingOrders.length ? ' -> ' + missingOrders.slice(0, 10).join(', ') : ''}`);
  if (!APPLY) console.log('\n(chạy lại với --apply để ghi)');

  await prisma.$disconnect();
})();
