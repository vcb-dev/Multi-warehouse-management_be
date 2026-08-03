/**
 * Kéo bù `location_id` cho những đơn mà lần phân trang theo tháng bỏ sót.
 *
 * Phân trang theo cửa sổ `created_on` không bao giờ phủ 100% (đơn bị sửa ngày, kết nối rớt
 * giữa trang...). Cách xử lý đã đúc kết: diff sapo_id trong DB với những gì kéo được, rồi
 * gọi `/admin/orders/{id}.json` cho từng đơn còn thiếu.
 *
 * Chạy:  set -a && . ./.env && set +a && node scripts-tmp/fill-location-gaps.js
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const JSONL = path.join(__dirname, 'order-locations.jsonl');
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
});
const STORE = process.env.SAPO_STORE;
const AUTH = Buffer.from(
  `${process.env.SAPO_API_KEY}:${process.env.SAPO_API_SECRET}`,
).toString('base64');

async function api(p, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(`https://${STORE}.mysapo.net${p}`, {
        headers: { Authorization: `Basic ${AUTH}` },
        signal: AbortSignal.timeout(45000),
      });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === tries) throw e;
      await new Promise((s) => setTimeout(s, 1200 * i));
    }
  }
}

async function main() {
  const have = new Set();
  for (const l of fs.readFileSync(JSONL, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    const o = JSON.parse(l);
    if (o.location_id != null) have.add(String(o.id));
  }

  const dbIds = (
    await prisma.$queryRawUnsafe(
      `SELECT sapo_id::text s FROM orders WHERE sapo_id IS NOT NULL`,
    )
  ).map((r) => r.s);
  const gaps = dbIds.filter((i) => !have.has(i));
  console.log(`${gaps.length} đơn cần kéo bù`);

  const out = fs.createWriteStream(JSONL, { flags: 'a' });
  let ok = 0;
  let miss = 0;
  for (const [i, id] of gaps.entries()) {
    const j = await api(`/admin/orders/${id}.json`);
    const o = j?.order;
    if (!o) {
      miss++;
      console.warn(`  ⚠ Sapo không có đơn ${id}`);
      continue;
    }
    out.write(JSON.stringify({ id: o.id, location_id: o.location_id ?? null }) + '\n');
    if (o.location_id != null) ok++;
    if ((i + 1) % 50 === 0) console.log(`  ...${i + 1}/${gaps.length}`);
  }
  out.end();
  console.log(`\nXong: ${ok} đơn có location, ${miss} đơn Sapo không trả về`);
}

main()
  .catch((e) => {
    console.error('LỖI:', e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
