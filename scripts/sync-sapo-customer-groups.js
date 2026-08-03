/**
 * Kéo NHÓM KHÁCH HÀNG từ Sapo về.
 *   node scripts/sync-sapo-customer-groups.js [--dry-run]
 *
 * Khác `backfill-sapo-customers.js` ở chỗ không quét lại toàn bộ 49.9k khách:
 * chỉ đụng tới nhóm, thành viên nhóm, và các trường tổng hợp của chính những
 * khách thuộc nhóm (endpoint thành viên trả sẵn nên không tốn thêm request).
 *
 * Cố ý KHÔNG ghi đè: first_name / last_name / phone / email / tags / note —
 * bản local đang có dữ liệu tốt hơn (VD 30k khách có tags mà Sapo trả rỗng).
 *
 * Nhóm được lưu `type = 'manual'` dù Sapo báo 'auto': dữ liệu local chưa đủ để
 * tính lại điều kiện (địa chỉ rỗng), nếu để 'auto' thì lần đầu ai đó lưu khách
 * hàng là `syncCustomerAutoGroups` xoá sạch thành viên vừa kéo về. Rule gốc vẫn
 * được lưu nguyên trong cột `rules` để bật 'auto' lại sau khi đã đồng bộ đủ.
 */
require('dotenv').config({ quiet: true });
const { PrismaClient, Prisma } = require('@prisma/client');

const prisma = new PrismaClient();
const DRY = process.argv.includes('--dry-run');
const STORE = process.env.SAPO_STORE;
const AUTH = Buffer.from(
  `${process.env.SAPO_API_KEY}:${process.env.SAPO_API_SECRET}`,
).toString('base64');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sapo trả 429 khá thường xuyên — lùi dần rồi thử lại. */
async function api(path, tries = 6) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(`https://${STORE}.mysapo.net${path}`, {
        headers: { Authorization: `Basic ${AUTH}` },
      });
      if (res.status === 429) {
        await sleep(2000 * i);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === tries) throw e;
      await sleep(1000 * i);
    }
  }
  throw new Error(`Hết lượt thử: ${path}`);
}

const toDate = (v) => (v ? new Date(v) : null);

async function fetchGroups() {
  const { customer_groups: groups } = await api(
    '/admin/customer_groups.json?limit=250',
  );
  return groups ?? [];
}

/**
 * Lấy hết thành viên của một nhóm.
 *
 * Endpoint này KHÁC /customers.json: trần `page * limit <= 30000` không áp
 * (đã thử page=121 vẫn trả đủ 250), và `created_on_min/max` bị bỏ qua hoàn toàn
 * — nên cứ phân trang thẳng tới khi gặp trang thiếu. Cận trên chỉ để phòng
 * trường hợp Sapo trả trang lặp vô hạn.
 */
async function fetchMembers(sapoGroupId) {
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= 2000; page++) {
    const j = await api(
      `/admin/customer_groups/${sapoGroupId}/customers.json?limit=250&page=${page}`,
    );
    const list = j.customers ?? [];
    for (const c of list) {
      // Chốt chặn: nếu Sapo lặp lại trang thì dừng thay vì phình vô hạn.
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
    if (list.length < 250) break;
    await sleep(250);
  }
  return out;
}

/** Khách có trong nhóm trên Sapo nhưng chưa từng về DB — tạo mới rồi mới liên kết. */
async function createMissing(members, idBySapo) {
  const missing = members.filter((c) => !idBySapo.has(String(c.id)));
  if (!missing.length) return 0;

  await prisma.customer.createMany({
    data: missing.map((c) => ({
      sapoId: BigInt(c.id),
      firstName: c.first_name || null,
      lastName: c.last_name || null,
      email: c.email || null,
      phone: c.phone || null,
      state: c.state || 'enabled',
      verifiedEmail: !!c.verified_email,
      gender: c.gender || null,
      dob: toDate(c.dob),
      acceptsMarketing: !!c.accepts_marketing,
      ordersCount: c.orders_count ?? 0,
      totalSpent: String(c.total_spent ?? 0),
      lastOrderId: c.last_order_id ? BigInt(c.last_order_id) : null,
      lastOrderName: c.last_order_name || null,
      note: c.note || null,
      tags: c.tags ? c.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      createdOn: toDate(c.created_on) ?? new Date(),
    })),
    skipDuplicates: true,
  });
  return missing.length;
}

/** Cập nhật các trường Sapo là nguồn chân lý, theo lô, 1 câu lệnh mỗi lô. */
async function updateAggregates(members, idBySapo) {
  const rows = [];
  for (const c of members) {
    const localId = idBySapo.get(String(c.id));
    if (!localId) continue;
    rows.push(
      Prisma.sql`(${localId}::bigint, ${c.state || 'enabled'}::text,
        ${!!c.verified_email}::boolean, ${c.gender || null}::text,
        ${toDate(c.dob)}::timestamp, ${!!c.accepts_marketing}::boolean,
        ${c.orders_count ?? 0}::int, ${String(c.total_spent ?? 0)}::decimal,
        ${c.last_order_id ? BigInt(c.last_order_id) : null}::bigint,
        ${c.last_order_name || null}::text)`,
    );
  }
  if (!rows.length) return 0;

  let done = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await prisma.$executeRaw`
      UPDATE customers AS t SET
        state = v.state, verified_email = v.verified_email, gender = v.gender,
        dob = v.dob, accepts_marketing = v.accepts_marketing,
        orders_count = v.orders_count, total_spent = v.total_spent,
        last_order_id = v.last_order_id, last_order_name = v.last_order_name
      FROM (VALUES ${Prisma.join(slice)}) AS v(id, state, verified_email, gender,
        dob, accepts_marketing, orders_count, total_spent, last_order_id, last_order_name)
      WHERE t.id = v.id`;
    done += slice.length;
  }
  return done;
}

(async () => {
  console.log(DRY ? '=== DRY RUN — không ghi gì ===\n' : '=== Đồng bộ nhóm khách hàng ===\n');

  const groups = await fetchGroups();
  console.log(`Sapo có ${groups.length} nhóm.\n`);

  let totalLinked = 0;
  let totalMissing = 0;
  let totalAggregates = 0;

  for (const g of groups) {
    const members = await fetchMembers(g.id);
    const sapoIds = members.map((c) => BigInt(c.id));

    const lookup = () =>
      sapoIds.length
        ? prisma.customer.findMany({
            where: { sapoId: { in: sapoIds } },
            select: { id: true, sapoId: true },
          })
        : Promise.resolve([]);

    let locals = await lookup();
    let idBySapo = new Map(locals.map((l) => [String(l.sapoId), l.id]));
    const missing = members.length - idBySapo.size;

    console.log(
      `- ${g.name} (sapo ${g.id}, ${g.type})\n` +
        `    Sapo: ${g.customers_count} | tải về: ${members.length} | khớp local: ${idBySapo.size}` +
        (missing ? ` | tạo mới: ${missing}` : ''),
    );
    totalMissing += missing;

    if (DRY) {
      totalLinked += members.length;
      continue;
    }

    if (missing) {
      await createMissing(members, idBySapo);
      locals = await lookup();
      idBySapo = new Map(locals.map((l) => [String(l.sapoId), l.id]));
    }
    totalLinked += locals.length;

    // Nhóm: giữ nguyên rules + disjunctive của Sapo, nhưng khoá về 'manual'.
    const data = {
      name: g.name,
      note: g.note || null,
      type: 'manual',
      disjunctive: !!g.disjunctive,
      rules: g.rules ?? [],
      catalogsCount: g.catalogs_count ?? 0,
      createdOn: toDate(g.created_on) ?? new Date(),
    };
    const row = await prisma.customerGroup.upsert({
      where: { sapoId: BigInt(g.id) },
      update: data,
      // `code` là mã nội bộ (Sapo không có) — sinh từ sapo_id cho nhóm đồng bộ về
      create: { ...data, sapoId: BigInt(g.id), code: `SAPO-${g.id}` },
    });

    // Thay trọn thành viên để chạy lại script là idempotent.
    await prisma.customerGroupMember.deleteMany({
      where: { customerGroupId: row.id },
    });
    if (locals.length) {
      await prisma.customerGroupMember.createMany({
        data: locals.map((c) => ({ customerId: c.id, customerGroupId: row.id })),
        skipDuplicates: true,
      });
    }
    await prisma.customerGroup.update({
      where: { id: row.id },
      data: { customersCount: locals.length },
    });

    totalAggregates += await updateAggregates(members, idBySapo);
  }

  console.log(
    `\nTổng: ${totalLinked} liên kết khách⇄nhóm` +
      (totalMissing ? `, ${totalMissing} khách mới tạo từ Sapo` : '') +
      `, ${totalAggregates} khách được cập nhật số liệu.`,
  );
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('LỖI:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
