/**
 * Backfill vận đơn (fulfillments) + dòng phí vận chuyển (order.shipping_lines)
 * từ Sapo — hai thứ này nằm sẵn trong payload `/admin/orders.json`, nhưng
 * `sync-new-sapo-orders.js` chỉ tạo đơn + line item, chưa từng đọc hai field
 * này nên bảng `fulfillments`/`fulfillment_line_items`/`order_shipping_lines`
 * trống hoàn toàn dù Sapo đã có ~76k đơn "fulfilled".
 *
 * Chạy: node scripts/backfill-sapo-fulfillments.js [--apply] [--from=ISO]
 *
 * Giống `backfill-sapo-customers.js`: quét theo cửa sổ tháng (Sapo chặn
 * page*limit<=30000) từ 2022-01-01 (đã kiểm chứng không có đơn nào trước đó).
 *
 * Không map được các *_user_id (picked/sorted/issued/handed/assigned_packer)
 * về User nội bộ — bảng `users` chưa có sapo_id thật (xem docs). Để NULL, chỉ
 * `created_by` là bắt buộc nên dùng user đầu tiên làm placeholder.
 * `provider_id`/`shipping_type`/phí/kích thước là khái niệm riêng của dự án
 * (tạo khi tự vận chuyển qua app) — Sapo không có nên để mặc định/NULL.
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

const toDate = (v) => (v ? new Date(v) : null);
const enumOr = (v, allowed) => (allowed.includes(v) ? v : null);

const PACKED = ['unknown', 'packing', 'packed'];
const SHIPMENT_STATUS = [
  'pending', 'picked_up', 'delivering', 'delivered',
  'retry_delivery', 'returning', 'returned', 'cancelled',
];
const DELIVERY_METHOD = [
  'external_service', 'ecommerce', 'pick_up', 'external_shipper', 'outside_shipper',
];
const SHIPMENT_CATEGORY = ['fast', 'other'];
const PACKAGE_CATEGORY = [
  'single_item_quantity', 'single_item_multiple_quantity', 'multiple_items',
];

(async () => {
  console.log(APPLY ? '=== GHI DỮ LIỆU ===\n' : '=== DRY RUN — không ghi gì ===\n');

  const [orders, locations, variants, fallbackUser] = await Promise.all([
    prisma.order.findMany({
      where: { sapoId: { not: null } },
      select: {
        id: true, sapoId: true,
        shippingName: true, shippingPhone: true,
        shippingAddress1: true, shippingAddress2: true,
        shippingWard: true, shippingDistrict: true, shippingProvince: true,
      },
    }),
    prisma.location.findMany({ where: { sapoId: { not: null } }, select: { id: true, sapoId: true } }),
    prisma.productVariant.findMany({ where: { sapoId: { not: null } }, select: { id: true, sapoId: true } }),
    prisma.user.findFirst({ select: { id: true } }),
  ]);
  const orderBySapo = new Map(orders.map((o) => [String(o.sapoId), o]));
  const locBySapo = new Map(locations.map((l) => [String(l.sapoId), l.id]));
  const varBySapo = new Map(variants.map((v) => [String(v.sapoId), v.id]));
  console.log(`Đơn cục bộ có sapo_id: ${orders.length}`);

  const existingFulfillmentSapoIds = new Set(
    (await prisma.fulfillment.findMany({ where: { sapoId: { not: null } }, select: { sapoId: true } }))
      .map((f) => String(f.sapoId)),
  );
  console.log(`Vận đơn đã có sẵn: ${existingFulfillmentSapoIds.size}\n`);

  const argFrom = process.argv.find((a) => a.startsWith('--from='));
  const start = new Date(argFrom ? argFrom.slice('--from='.length) : '2022-01-01');
  start.setDate(1);
  start.setHours(0, 0, 0, 0);

  let totalOrdersSeen = 0;
  let totalOrdersMatched = 0;
  let totalShippingLines = 0;
  let totalFulfillments = 0;
  let totalFulfillmentItems = 0;
  let skipNoLocalOrder = 0;
  let skipNoVariant = 0;

  for (let d = new Date(start); d <= new Date(); d.setMonth(d.getMonth() + 1)) {
    const from = new Date(d);
    const to = new Date(d);
    to.setMonth(to.getMonth() + 1);
    const label = from.toISOString().slice(0, 7);

    let page = 1;
    let monthOrders = 0;
    let monthFulfillments = 0;
    while (page * 250 <= 30000) {
      const j = await api(
        `/admin/orders.json?limit=250&page=${page}` +
          `&created_on_min=${from.toISOString()}&created_on_max=${to.toISOString()}`,
      );
      const list = j.orders ?? [];
      if (!list.length) break;
      totalOrdersSeen += list.length;
      monthOrders += list.length;

      const shippingLineRows = [];
      const orderIdsWithShippingLines = [];
      const fulfillmentRows = []; // { sapoId, data, lineItems: [] }

      for (const o of list) {
        const local = orderBySapo.get(String(o.id));
        if (!local) {
          skipNoLocalOrder += 1;
          continue;
        }
        totalOrdersMatched += 1;

        if (o.shipping_lines?.length) {
          orderIdsWithShippingLines.push(local.id);
          for (const sl of o.shipping_lines) {
            shippingLineRows.push({
              orderId: local.id,
              title: sl.title || null,
              code: sl.code || null,
              source: sl.source || null,
              price: String(sl.price ?? 0),
              carrier: sl.carrier || null,
              carrierName: sl.carrier_name || null,
              discountAllocations: sl.discount_allocations ?? null,
              taxLines: sl.tax_lines ?? null,
            });
          }
        }

        for (const f of o.fulfillments ?? []) {
          if (existingFulfillmentSapoIds.has(String(f.id))) continue;
          existingFulfillmentSapoIds.add(String(f.id)); // tránh trùng nếu 1 đơn xuất hiện 2 lần trong cùng batch

          const oa = f.origin_address ?? {};
          const ti = f.tracking_info ?? {};
          fulfillmentRows.push({
            sapoId: BigInt(f.id),
            name: String(f.name ?? f.id),
            orderId: local.id,
            storeId: f.store_id ? BigInt(f.store_id) : null,
            status: f.status || 'success',
            packedStatus: enumOr(f.packed_status, PACKED),
            packedOn: toDate(f.packed_on),
            shipmentStatus: enumOr(f.shipment_status, SHIPMENT_STATUS),
            deliveryMethod: enumOr(f.delivery_method, DELIVERY_METHOD),
            shipmentCategory: enumOr(f.shipment_category, SHIPMENT_CATEGORY),
            packageCategory: enumOr(f.package_category, PACKAGE_CATEGORY),
            trackingNumber: f.tracking_number || null,
            trackingUrl: f.tracking_url || null,
            trackingCompany: f.tracking_company || null,
            carrier: ti.carrier || null,
            carrierName: ti.carrier_name || null,
            trackingNumbers: f.tracking_numbers ?? [],
            trackingUrls: f.tracking_urls ?? [],
            shippingLabelSlipUrl: f.shipping_label_slip_url || null,
            shippingLabelSlipError: f.shipping_label_slip_error || null,
            notifyCustomer: !!f.notify_customer,
            totalQuantity: f.total_quantity ?? 0,
            sla: f.sla ?? null,
            abnormal: f.abnormal ?? null,
            pickingIssues: f.picking_issues ?? null,
            toName: local.shippingName ?? null,
            toPhone: local.shippingPhone ?? null,
            toAddress: [local.shippingAddress1, local.shippingAddress2].filter(Boolean).join(', ') || null,
            toWard: local.shippingWard ?? null,
            toDistrict: local.shippingDistrict ?? null,
            toProvince: local.shippingProvince ?? null,
            locationId: locBySapo.get(String(f.location_id)) ?? null,
            originName: oa.name || null,
            originEmail: oa.email || null,
            originPhone: oa.phone || null,
            originAddress1: oa.address1 || null,
            originAddress2: oa.address2 || null,
            originWard: oa.ward || null,
            originWardCode: oa.ward_code || null,
            originDistrict: oa.district || null,
            originDistrictCode: oa.district_code || null,
            originProvince: oa.province || null,
            originProvinceCode: oa.province_code || null,
            originCity: oa.city || null,
            originCountry: oa.country || null,
            originCountryCode: oa.country_code || null,
            originZipCode: oa.zip_code || null,
            shipmentCreatedOn: toDate(f.shipment_created_on),
            pickedOn: toDate(f.picked_on),
            sortedOn: toDate(f.sorted_on),
            inspectedOn: toDate(f.inspected_on),
            issuedOn: toDate(f.issued_on),
            issuedBy: f.issued_by || null,
            handedOverAt: toDate(f.handed_over_at),
            handedBy: f.handed_by || null,
            deliveredOn: toDate(f.delivered_on),
            expectedDeliveryDate: toDate(f.expected_delivery_date),
            orderShipDeadline: toDate(f.order_ship_deadline),
            cancelledOn: toDate(f.cancelled_on),
            cancelReason: f.cancel_reason || null,
            createdById: fallbackUser.id,
            createdOn: toDate(f.created_on) ?? new Date(),
            // modifiedOn: @updatedAt tự set
            lineItems: (f.line_items ?? []).map((li) => {
              const variantId = varBySapo.get(String(li.variant_id));
              return { variantId, li };
            }),
          });
        }
      }

      if (orderIdsWithShippingLines.length && APPLY) {
        await prisma.orderShippingLine.deleteMany({
          where: { orderId: { in: orderIdsWithShippingLines } },
        });
        await prisma.orderShippingLine.createMany({ data: shippingLineRows });
      }
      totalShippingLines += shippingLineRows.length;

      if (fulfillmentRows.length) {
        monthFulfillments += fulfillmentRows.length;
        totalFulfillments += fulfillmentRows.length;

        if (APPLY) {
          await prisma.fulfillment.createMany({
            data: fulfillmentRows.map(({ lineItems, ...f }) => f),
            skipDuplicates: true,
          });
          const created = await prisma.fulfillment.findMany({
            where: { sapoId: { in: fulfillmentRows.map((f) => f.sapoId) } },
            select: { id: true, sapoId: true },
          });
          const idBySapo = new Map(created.map((c) => [String(c.sapoId), c.id]));

          const itemRows = [];
          for (const f of fulfillmentRows) {
            const fulfillmentId = idBySapo.get(String(f.sapoId));
            if (!fulfillmentId) continue;
            for (const { variantId, li } of f.lineItems) {
              if (!variantId) {
                skipNoVariant += 1;
                continue;
              }
              itemRows.push({
                fulfillmentId,
                orderItemId: null,
                variantId,
                productId: li.product_id ? BigInt(li.product_id) : null,
                name: li.name || li.title || '',
                title: li.title || null,
                variantTitle: li.variant_title || null,
                sku: li.sku || '',
                quantity: li.quantity ?? 0,
                effectiveQuantity: li.effective_quantity ?? null,
                fulfillableQuantity: li.fulfillable_quantity ?? null,
                nonFulfillableQuantity: li.non_fulfillable_quantity ?? null,
                refundableQuantity: li.refundable_quantity ?? null,
                price: String(li.price ?? 0),
                totalDiscount: String(li.total_discount ?? 0),
                discountedTotal: String(li.discounted_total ?? li.price ?? 0),
                originalTotal: li.original_total != null ? String(li.original_total) : null,
                grams: li.grams ?? null,
                taxable: li.taxable ?? true,
                requiresShipping: li.requires_shipping ?? true,
                restockable: li.restockable ?? true,
                fulfillmentStatus: li.fulfillment_status || null,
              });
            }
          }
          totalFulfillmentItems += itemRows.length;
          if (itemRows.length) {
            await prisma.fulfillmentLineItem.createMany({ data: itemRows });
          }
        } else {
          for (const f of fulfillmentRows) {
            for (const { variantId } of f.lineItems) {
              if (!variantId) skipNoVariant += 1;
              else totalFulfillmentItems += 1;
            }
          }
        }
      }

      if (page % 20 === 0 || list.length < 250) {
        console.log(
          `  ${label} trang ${page}: ${monthOrders} đơn quét, ${monthFulfillments} vận đơn mới`,
        );
      }
      if (list.length < 250) break;
      page += 1;
    }
    if (page * 250 > 30000) {
      console.warn(`  ⚠ ${label} chạm trần 30000 — cửa sổ này có thể còn sót đơn`);
    }
  }

  console.log('\n=== KẾT QUẢ ===');
  console.log(`đơn quét: ${totalOrdersSeen} (khớp local: ${totalOrdersMatched}, không có local: ${skipNoLocalOrder})`);
  console.log(`dòng phí vận chuyển: ${totalShippingLines}`);
  console.log(`vận đơn mới: ${totalFulfillments} | dòng hàng vận đơn: ${totalFulfillmentItems} (bỏ qua thiếu variant: ${skipNoVariant})`);
  if (!APPLY) console.log('\n(chạy lại với --apply để ghi)');

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('LỖI:', e);
  await prisma.$disconnect();
  process.exit(1);
});
