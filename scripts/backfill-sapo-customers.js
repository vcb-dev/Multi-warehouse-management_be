/**
 * Backfill khách hàng + nhóm khách hàng từ Sapo.
 * Chạy: node scripts/backfill-sapo-customers.js
 *
 * Sapo không trả nhóm trong /customers.json — phải lấy ngược từ
 * /customer_groups/{id}/customers.json (xem docs/sapo-schema-mapping.md).
 */
require('dotenv').config({ quiet: true });
const { PrismaClient, Prisma } = require('@prisma/client');

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
      // Kết nối tới Sapo hay rớt giữa chừng trên tập lớn — lùi dần rồi thử lại.
      if (i === tries) throw e;
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
}

const toDate = (v) => (v ? new Date(v) : null);

async function syncGroups() {
  const { customer_groups: groups } = await api('/admin/customer_groups.json?limit=250');
  console.log(`Nhóm khách từ Sapo: ${groups.length}`);
  const idMap = new Map();

  for (const g of groups) {
    const data = {
      name: g.name,
      note: g.note || null,
      type: g.type || 'manual',
      disjunctive: !!g.disjunctive,
      rules: g.rules ?? null,
      customersCount: g.customers_count ?? 0,
      catalogsCount: g.catalogs_count ?? 0,
      createdOn: toDate(g.created_on) ?? new Date(),
    };
    const row = await prisma.customerGroup.upsert({
      where: { sapoId: BigInt(g.id) },
      update: data,
      // `code` là mã nội bộ (Sapo không có) — sinh từ sapo_id cho nhóm đồng bộ về
      create: { ...data, sapoId: BigInt(g.id), code: `SAPO-${g.id}` },
    });
    idMap.set(String(g.id), row.id);
  }
  return idMap;
}

async function syncGroupMembers(idMap) {
  let total = 0;
  for (const [sapoGroupId, localGroupId] of idMap) {
    let page = 1;
    const sapoCustomerIds = [];
    // page * limit <= 30000 (giới hạn Sapo)
    while (page * 250 <= 30000) {
      const j = await api(
        `/admin/customer_groups/${sapoGroupId}/customers.json?limit=250&page=${page}`,
      );
      const list = j.customers ?? [];
      if (!list.length) break;
      sapoCustomerIds.push(...list.map((c) => BigInt(c.id)));
      if (list.length < 250) break;
      page += 1;
    }
    if (!sapoCustomerIds.length) continue;

    const locals = await prisma.customer.findMany({
      where: { sapoId: { in: sapoCustomerIds } },
      select: { id: true },
    });
    await prisma.customerGroupMember.createMany({
      data: locals.map((c) => ({ customerId: c.id, customerGroupId: localGroupId })),
      skipDuplicates: true,
    });
    total += locals.length;
    console.log(`  nhóm ${sapoGroupId}: ${locals.length}/${sapoCustomerIds.length} khách khớp`);
  }
  console.log(`Tổng liên kết khách⇄nhóm: ${total}`);
}

/**
 * Sapo chặn `page * limit > 30000`, mà cửa hàng có ~49.9k khách → phải chia
 * cửa sổ theo tháng tạo (`created_on_min`/`created_on_max`) như đã làm với orders.
 */
async function syncCustomersWindow(query, label) {
  let page = 1;
  let updated = 0;
  let addrCount = 0;
  let created = 0;

  while (page * 250 <= 30000) {
    const j = await api(`/admin/customers.json?limit=250&page=${page}${query}`);
    const list = j.customers ?? [];
    if (!list.length) break;

    // Một round-trip để tra id nội bộ cho cả trang, thay vì findUnique từng khách.
    const sapoIds = list.map((c) => BigInt(c.id));
    let locals = await prisma.customer.findMany({
      where: { sapoId: { in: sapoIds } },
      select: { id: true, sapoId: true },
    });
    let idBySapo = new Map(locals.map((l) => [String(l.sapoId), l.id]));

    // Khách chỉ có ở Sapo (chưa từng phát sinh đơn nên chưa có trong DB) — tạo mới,
    // rồi tra lại id để phần cập nhật bên dưới xử lý luôn như khách cũ.
    const missing = list.filter((c) => !idBySapo.has(String(c.id)));
    if (missing.length) {
      await prisma.customer.createMany({
        data: missing.map((c) => ({
          sapoId: BigInt(c.id),
          firstName: c.first_name || null,
          lastName: c.last_name || null,
          email: c.email || null,
          phone: c.phone || null,
          tags: c.tags ? c.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
        })),
        skipDuplicates: true,
      });
      created += missing.length;
      locals = await prisma.customer.findMany({
        where: { sapoId: { in: sapoIds } },
        select: { id: true, sapoId: true },
      });
      idBySapo = new Map(locals.map((l) => [String(l.sapoId), l.id]));
    }

    // UPDATE ... FROM (VALUES ...) — cập nhật cả trang trong 1 câu lệnh.
    const rows = [];
    for (const c of list) {
      const localId = idBySapo.get(String(c.id));
      if (!localId) continue;
      rows.push(
        Prisma.sql`(${localId}::bigint, ${c.state || 'enabled'}::text,
          ${!!c.verified_email}::boolean, ${c.gender || null}::text,
          ${toDate(c.dob)}::timestamp, ${!!c.accepts_marketing}::boolean,
          ${c.orders_count ?? 0}::int, ${String(c.total_spent ?? 0)}::decimal,
          ${c.last_order_name || null}::text, ${c.note || null}::text,
          ${toDate(c.created_on) ?? new Date()}::timestamp)`,
      );
    }
    if (rows.length) {
      await prisma.$executeRaw`
        UPDATE customers AS t SET
          state = v.state, verified_email = v.verified_email, gender = v.gender,
          dob = v.dob, accepts_marketing = v.accepts_marketing,
          orders_count = v.orders_count, total_spent = v.total_spent,
          last_order_name = v.last_order_name,
          note = COALESCE(v.note, t.note), created_on = v.created_on
        FROM (VALUES ${Prisma.join(rows)}) AS v(id, state, verified_email, gender, dob,
          accepts_marketing, orders_count, total_spent, last_order_name, note, created_on)
        WHERE t.id = v.id`;
      updated += rows.length;
    }

    // Địa chỉ: gom cả trang rồi ghi 1 lần (xoá theo sapo_id trước để idempotent)
    const addrs = [];
    for (const c of list) {
      const localId = idBySapo.get(String(c.id));
      if (!localId) continue;
      for (const a of c.addresses ?? []) {
        addrs.push({
          sapoId: BigInt(a.id),
          customerId: localId,
          firstName: a.first_name || null,
          lastName: a.last_name || null,
          phone: a.phone || null,
          company: a.company || null,
          address1: a.address1 || null,
          address2: a.address2 || null,
          ward: a.ward || null,
          wardCode: a.ward_code || null,
          district: a.district || null,
          districtCode: a.district_code || null,
          province: a.province || null,
          provinceCode: a.province_code || null,
          city: a.city || null,
          country: a.country || null,
          countryCode: a.country_code || null,
          zip: a.zip || null,
          isDefault: !!a.default,
        });
      }
    }
    if (addrs.length) {
      await prisma.customerAddress.deleteMany({
        where: { sapoId: { in: addrs.map((a) => a.sapoId) } },
      });
      await prisma.customerAddress.createMany({ data: addrs, skipDuplicates: true });
      addrCount += addrs.length;
    }

    if (page % 20 === 0 || list.length < 250) {
      console.log(
        `  ${label} trang ${page}: ${updated} khách (${created} tạo mới), ${addrCount} địa chỉ`,
      );
    }
    if (list.length < 250) break;
    page += 1;
  }
  if (page * 250 > 30000) {
    console.warn(`  ⚠ ${label} chạm trần 30000 — cửa sổ này có thể còn sót khách`);
  }
  return { updated, addrCount, created };
}

async function syncCustomers() {
  // KHÔNG lấy mốc bắt đầu từ created_on nhỏ nhất trong DB nội bộ: sau khi gộp
  // sang project Supabase thứ 3, phần lớn khách cũ bị lệch created_on về một
  // khoảng gần đây (không phải created_on thật của Sapo) — dùng mốc này làm
  // "start" bỏ sót toàn bộ khách cũ. Đã kiểm chứng Sapo không có khách nào
  // created_on trước 2022-01-01 (customers/count.json?created_on_max=...=0),
  // nên cố định mốc quét từ đó cho chắc.
  const start = new Date('2022-01-01');
  start.setDate(1);
  start.setHours(0, 0, 0, 0);

  let totalC = 0;
  let totalA = 0;
  let totalNew = 0;
  for (let d = new Date(start); d <= new Date(); d.setMonth(d.getMonth() + 1)) {
    const from = new Date(d);
    const to = new Date(d);
    to.setMonth(to.getMonth() + 1);
    const label = from.toISOString().slice(0, 7);
    const q =
      `&created_on_min=${from.toISOString()}&created_on_max=${to.toISOString()}`;
    const r = await syncCustomersWindow(q, label);
    totalC += r.updated;
    totalA += r.addrCount;
    totalNew += r.created;
  }
  console.log(`Xong: ${totalC} khách (${totalNew} tạo mới), ${totalA} địa chỉ.`);
}

(async () => {
  const idMap = await syncGroups();
  await syncCustomers();
  await syncGroupMembers(idMap);
  await prisma.$disconnect();
})();
