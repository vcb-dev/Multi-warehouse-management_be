/**
 * Sửa `orders.name`: lần sync đơn gốc lưu nhầm **Sapo order ID** vào mã đơn
 * thay vì `order.name` thật (vd lưu 159271159 thay vì HK72759).
 * Ảnh hưởng 84.723/87.911 đơn đã đồng bộ.
 *
 * Chạy: node scripts/fix-order-names.js [--apply]
 * Không có --apply thì chỉ kiểm tra va chạm rồi dừng (name là UNIQUE).
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

(async () => {
  // 1) Gom map sapo_id -> name thật từ Sapo (cửa sổ theo tháng, giới hạn 30000)
  const first = await prisma.order.findFirst({
    where: { sapoId: { not: null } },
    orderBy: { createdOn: 'asc' },
    select: { createdOn: true },
  });
  const start = new Date(first?.createdOn ?? '2025-01-01');
  start.setDate(1);
  start.setHours(0, 0, 0, 0);

  const nameBySapo = new Map();
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
      for (const o of list) nameBySapo.set(String(o.id), String(o.name ?? ''));
      if (list.length < 250) break;
      page += 1;
    }
    console.log(`  ${label}: đã gom ${nameBySapo.size} mã đơn`);
  }
  console.log(`Tổng mã đơn lấy được từ Sapo: ${nameBySapo.size}`);

  // 2) Những đơn đang sai (name == sapo_id)
  const wrong = await prisma.$queryRawUnsafe(`
    SELECT id, sapo_id, name FROM orders
    WHERE sapo_id IS NOT NULL AND name = sapo_id::text`);
  console.log(`Đơn đang mang mã sai: ${wrong.length}`);

  // 3) Kiểm tra va chạm TRƯỚC khi ghi (cột name là UNIQUE)
  const existing = new Set(
    (await prisma.order.findMany({ select: { name: true } })).map((o) => o.name),
  );
  const planned = [];
  const seen = new Set();
  let noName = 0;
  let dupInBatch = 0;
  let clashExisting = 0;

  for (const o of wrong) {
    const real = nameBySapo.get(String(o.sapo_id));
    if (!real) {
      noName += 1;
      continue;
    }
    if (seen.has(real)) {
      dupInBatch += 1;
      continue;
    }
    // Va chạm với đơn khác đang giữ đúng mã đó (và không phải chính nó)
    if (existing.has(real) && real !== o.name) {
      clashExisting += 1;
      continue;
    }
    seen.add(real);
    planned.push({ id: o.id, name: real });
  }

  console.log(`\n=== KIỂM TRA VA CHẠM ===`);
  console.log(`sửa được      : ${planned.length}`);
  console.log(`không có mã   : ${noName} (Sapo không trả về trong cửa sổ đã quét)`);
  console.log(`trùng trong lô: ${dupInBatch}`);
  console.log(`trùng mã sẵn có: ${clashExisting}`);

  if (!APPLY) {
    console.log('\n(chạy lại với --apply để ghi)');
    await prisma.$disconnect();
    return;
  }

  // 4) Ghi theo lô 500 dòng bằng UPDATE ... FROM (VALUES ...)
  let done = 0;
  for (let i = 0; i < planned.length; i += 500) {
    const chunk = planned.slice(i, i + 500);
    const values = chunk.map((r) => Prisma.sql`(${r.id}::bigint, ${r.name}::text)`);
    await db(() =>
      prisma.$executeRaw`
        UPDATE orders AS t SET name = v.name
        FROM (VALUES ${Prisma.join(values)}) AS v(id, name)
        WHERE t.id = v.id`,
    );
    done += chunk.length;
    if (done % 5000 === 0 || done === planned.length) {
      console.log(`  ...${done}/${planned.length}`);
    }
  }
  console.log(`\n✅ Đã sửa ${done} mã đơn.`);
  await prisma.$disconnect();
})();
