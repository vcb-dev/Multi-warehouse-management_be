/**
 * Đồng bộ những đơn Sapo phát sinh SAU lần sync cuối (chưa có trong DB).
 *
 * Chạy: node scripts/sync-new-sapo-orders.js [--apply]
 *
 * KHÔNG sinh inventory_movements — giống cách 87.911 đơn lịch sử đã được nạp
 * (tồn kho lấy thẳng từ Sapo, không dựng lại lịch sử xuất/nhập).
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
const enumOr = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

const STATUS = ['open', 'closed', 'cancelled'];
const FIN = ['pending', 'partially_paid', 'paid', 'refunded', 'partially_refunded'];
const FUL = ['partial', 'fulfilled'];
const RET = ['no_return', 'in_progress', 'returned'];
const REF = ['no_refund', 'refunded', 'partial'];
const RESTOCK = ['no_restock', 'restocked', 'partial'];

(async () => {
  const [locations, variants, customers, fallbackUser, defaultLoc] = await Promise.all([
    prisma.location.findMany({ where: { sapoId: { not: null } }, select: { id: true, sapoId: true } }),
    prisma.productVariant.findMany({ where: { sapoId: { not: null } }, select: { id: true, sapoId: true } }),
    prisma.customer.findMany({ where: { sapoId: { not: null } }, select: { id: true, sapoId: true } }),
    prisma.user.findFirst({ select: { id: true } }),
    prisma.location.findFirst({ orderBy: { id: 'asc' }, select: { id: true } }),
  ]);
  const locBySapo = new Map(locations.map((l) => [String(l.sapoId), l.id]));
  const varBySapo = new Map(variants.map((v) => [String(v.sapoId), v.id]));
  const cusBySapo = new Map(customers.map((c) => [String(c.sapoId), c.id]));

  // Cho phép chỉ định mốc (vd chạy lại vùng cũ để vớt đơn từng bị bỏ vì
  // thiếu phiên bản); mặc định lấy từ đơn Sapo mới nhất trong DB.
  const argFrom = process.argv.find((a) => a.startsWith('--from='));
  const last = await prisma.order.findFirst({
    where: { sapoId: { not: null } },
    orderBy: { createdOn: 'desc' },
    select: { createdOn: true },
  });
  const since = argFrom ? argFrom.slice('--from='.length) : last.createdOn.toISOString();
  console.log(`Lấy đơn Sapo tạo từ ${since}`);

  const existing = new Set(
    (await prisma.order.findMany({ where: { sapoId: { not: null } }, select: { sapoId: true } }))
      .map((o) => String(o.sapoId)),
  );
  const usedNames = new Set(
    (await prisma.order.findMany({ select: { name: true } })).map((o) => o.name),
  );

  let page = 1;
  let created = 0;
  let lines = 0;
  let skipExisting = 0;
  let skipNoVariantLine = 0;
  let failed = 0;

  while (page * 250 <= 30000) {
    const j = await api(`/admin/orders.json?limit=250&page=${page}&created_on_min=${since}`);
    const list = j.orders ?? [];
    if (!list.length) break;

    for (const o of list) {
      if (existing.has(String(o.id))) {
        skipExisting += 1;
        continue;
      }
      // `name` là UNIQUE — đơn trùng mã thì thêm hậu tố id để không vỡ ràng buộc
      let name = String(o.name ?? o.id);
      if (usedNames.has(name)) name = `${name}-${o.id}`;

      const items = [];
      for (const l of o.line_items ?? []) {
        const variantId = varBySapo.get(String(l.variant_id));
        if (!variantId) {
          skipNoVariantLine += 1;
          continue;
        }
        items.push({
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
      if (!items.length) continue;

      const sa = o.shipping_address ?? {};
      const data = {
        sapoId: BigInt(o.id),
        name,
        number: o.number ?? null,
        orderNumber: o.order_number ?? null,
        locationId: locBySapo.get(String(o.location_id)) ?? defaultLoc.id,
        customerId: cusBySapo.get(String(o.customer?.id)) ?? null,
        createdById: fallbackUser.id,
        sourceName: o.source_name || null,
        status: enumOr(o.status, STATUS, 'open'),
        financialStatus: enumOr(o.financial_status, FIN, 'pending'),
        fulfillmentStatus: FUL.includes(o.fulfillment_status) ? o.fulfillment_status : null,
        returnStatus: enumOr(o.return_status, RET, 'no_return'),
        refundStatus: enumOr(o.refund_status, REF, 'no_refund'),
        restockStatus: RESTOCK.includes(o.restock_status) ? o.restock_status : null,
        issueStatus: o.issue_status || null,
        email: o.email || null,
        phone: o.phone || sa.phone || null,
        subTotalPrice: String(o.sub_total_price ?? 0),
        totalDiscounts: String(o.total_discounts ?? 0),
        totalTax: String(o.total_tax ?? 0),
        totalShippingPrice: String(o.total_shipping_price ?? 0),
        totalPrice: String(o.total_price ?? 0),
        subtotalLineItemsQuantity: o.subtotal_line_items_quantity ?? 0,
        totalReceived: String(o.total_received ?? 0),
        currency: o.currency || 'VND',
        gateway: o.gateway || null,
        totalWeight: o.total_weight ?? null,
        unpaidAmount: o.unpaid_amount != null ? String(o.unpaid_amount) : null,
        totalOutstanding: o.total_outstanding != null ? String(o.total_outstanding) : null,
        totalRefunded: o.total_refunded != null ? String(o.total_refunded) : null,
        note: o.note || null,
        tags: o.tags ? o.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
        createdOn: toDate(o.created_on) ?? new Date(),
        cancelledOn: toDate(o.cancelled_on),
        cancelReason: o.cancel_reason || null,
        closedOn: toDate(o.closed_on),
        completedOn: toDate(o.completed_on),
        paidOn: toDate(o.paid_on),
        processedOn: toDate(o.processed_on),
        deliveredOn: toDate(o.delivered_on),
        expectedDeliveryDate: toDate(o.expected_delivery_date),
        shippingName: sa.name || null,
        shippingFirstName: sa.first_name || null,
        shippingLastName: sa.last_name || null,
        shippingPhone: sa.phone || null,
        shippingAddress1: sa.address1 || null,
        shippingAddress2: sa.address2 || null,
        shippingWard: sa.ward || null,
        shippingWardCode: sa.ward_code || null,
        shippingDistrict: sa.district || null,
        shippingDistrictCode: sa.district_code || null,
        shippingProvince: sa.province || null,
        shippingProvinceCode: sa.province_code || null,
        shippingCity: sa.city || null,
        shippingCountry: sa.country || null,
        shippingCountryCode: sa.country_code || null,
        shippingZip: sa.zip || null,
        items: { create: items },
      };

      if (!APPLY) {
        created += 1;
        lines += items.length;
        usedNames.add(name);
        existing.add(String(o.id));
        continue;
      }
      try {
        await db(() => prisma.order.create({ data }));
        created += 1;
        lines += items.length;
        usedNames.add(name);
        existing.add(String(o.id));
        if (created % 100 === 0) console.log(`  ...${created} đơn, ${lines} dòng`);
      } catch (e) {
        failed += 1;
        console.warn(`  ⚠ ${o.name}: ${e.message.split('\n')[0]}`);
      }
    }

    if (list.length < 250) break;
    page += 1;
  }

  console.log('\n=== KẾT QUẢ ===');
  console.log(`đơn tạo mới: ${created} | dòng hàng: ${lines}`);
  console.log(`bỏ qua: ${skipExisting} đã có, ${skipNoVariantLine} dòng thiếu phiên bản, ${failed} lỗi`);
  if (!APPLY) console.log('\n(chạy lại với --apply để ghi)');

  await prisma.$disconnect();
})();
