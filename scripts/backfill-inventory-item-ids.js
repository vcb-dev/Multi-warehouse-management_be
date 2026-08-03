/**
 * Điền `product_variants.inventory_item_id` từ Sapo.
 *
 * Vì sao cần: 0/16.225 phiên bản có trường này. Không có nó thì không gọi được
 * API tồn kho/giá vốn của Sapo (`/admin/inventory_items.json?ids=...`), nên nó
 * chặn luôn việc backfill giá vốn.
 *
 * Chạy thử (không ghi):  node scripts/backfill-inventory-item-ids.js
 * Ghi thật:              node scripts/backfill-inventory-item-ids.js --apply
 */
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const { PrismaClient, Prisma } = require('@prisma/client');

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const STORE = process.env.SAPO_STORE;
const AUTH = Buffer.from(
  `${process.env.SAPO_API_KEY}:${process.env.SAPO_API_SECRET}`,
).toString('base64');

const PAGE_SIZE = 250;
const WRITE_CHUNK = 1000;
const UNMATCHED_FILE = 'scripts-tmp/inventory-item-id-unmatched.json';

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

/** Cập nhật theo lô — 16k lệnh update lẻ trên đường truyền này là không khả thi. */
async function flush(rows) {
  if (!rows.length || !APPLY) return;
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const chunk = rows.slice(i, i + WRITE_CHUNK);
    const values = chunk.map(
      (r) => Prisma.sql`(${r.id}::bigint, ${r.invId}::bigint)`,
    );
    await prisma.$executeRaw`
      UPDATE product_variants AS t SET inventory_item_id = v.inv
      FROM (VALUES ${Prisma.join(values)}) AS v(id, inv)
      WHERE t.id = v.id`;
  }
}

(async () => {
  console.log(APPLY ? '>>> CHẾ ĐỘ GHI THẬT' : '>>> chạy thử, không ghi gì');

  const local = await prisma.productVariant.findMany({
    where: { sapoId: { not: null } },
    select: { id: true, sapoId: true, inventoryItemId: true },
  });
  const bySapoId = new Map(local.map((v) => [v.sapoId.toString(), v]));
  const tongKhongSapoId = await prisma.productVariant.count({
    where: { sapoId: null },
  });

  console.log(
    `Local: ${local.length} phiên bản có sapo_id, ${tongKhongSapoId} không có ` +
      `(không khớp được, sẽ xuất ra file).`,
  );

  const toUpdate = [];
  let seenOnSapo = 0;
  let daDung = 0;
  const matched = new Set();

  for (let page = 1; ; page++) {
    const j = await api(`/admin/products.json?page=${page}&limit=${PAGE_SIZE}`);
    const products = j.products ?? [];
    if (!products.length) break;

    for (const p of products) {
      for (const v of p.variants ?? []) {
        seenOnSapo += 1;
        const row = bySapoId.get(String(v.id));
        if (!row) continue;
        matched.add(row.id.toString());
        if (!v.inventory_item_id) continue;
        const invId = BigInt(v.inventory_item_id);
        if (row.inventoryItemId === invId) {
          daDung += 1;
          continue;
        }
        toUpdate.push({ id: row.id, invId });
      }
    }
    process.stdout.write(`\r  trang ${page} — đã quét ${seenOnSapo} phiên bản Sapo`);
    if (products.length < PAGE_SIZE) break;
  }
  console.log('');

  const khongThayTrenSapo = local.filter((v) => !matched.has(v.id.toString()));

  console.log(`\nKẾT QUẢ`);
  console.log(`  phiên bản Sapo đã quét:        ${seenOnSapo}`);
  console.log(`  sẽ cập nhật inventory_item_id: ${toUpdate.length}`);
  console.log(`  đã đúng sẵn:                   ${daDung}`);
  console.log(`  có sapo_id nhưng Sapo không còn: ${khongThayTrenSapo.length}`);
  console.log(`  không có sapo_id (bỏ qua):     ${tongKhongSapoId}`);

  if (khongThayTrenSapo.length) {
    fs.mkdirSync('scripts-tmp', { recursive: true });
    fs.writeFileSync(
      UNMATCHED_FILE,
      JSON.stringify(
        khongThayTrenSapo.map((v) => ({
          variant_id: v.id.toString(),
          sapo_id: v.sapoId.toString(),
        })),
        null,
        1,
      ),
    );
    console.log(`  → danh sách không khớp: ${UNMATCHED_FILE}`);
  }

  await flush(toUpdate);

  if (APPLY) {
    const con = await prisma.productVariant.count({
      where: { inventoryItemId: null },
    });
    console.log(`\nĐã ghi. Còn ${con} phiên bản chưa có inventory_item_id.`);
  } else {
    console.log(`\nChưa ghi gì. Thêm --apply để cập nhật.`);
  }
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
