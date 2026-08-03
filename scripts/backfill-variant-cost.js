/**
 * Điền `product_variants.cost` (giá vốn) từ Sapo `InventoryItem.cost_price`.
 *
 * Vì sao cần: 16.209/16.225 phiên bản đang có cost = 0 nên mọi báo cáo lãi gộp
 * đều sai. Schema đã ghi rõ nguồn dữ liệu ("đồng bộ từ InventoryItem.cost_price")
 * nhưng chưa có code nào thực hiện.
 *
 * Cột này là fallback của cả hai báo cáo:
 *   - lãi gộp:  COALESCE(oi.cost_price, v.cost, 0)      — report-sql.ts:62
 *   - tồn kho:  COALESCE(NULLIF(il.cost,0), v.cost, 0)  — inventory.report.ts:42
 *
 * Phụ thuộc: chạy scripts/backfill-inventory-item-ids.js trước.
 *
 * Chạy thử:  node scripts/backfill-variant-cost.js
 * Ghi thật:  node scripts/backfill-variant-cost.js --apply
 */
require('dotenv').config({ quiet: true });
const { PrismaClient, Prisma } = require('@prisma/client');

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const STORE = process.env.SAPO_STORE;
const AUTH = Buffer.from(
  `${process.env.SAPO_API_KEY}:${process.env.SAPO_API_SECRET}`,
).toString('base64');

const ID_BATCH = 250;
const WRITE_CHUNK = 1000;

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

async function flush(rows) {
  if (!rows.length || !APPLY) return;
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const chunk = rows.slice(i, i + WRITE_CHUNK);
    const values = chunk.map(
      (r) => Prisma.sql`(${r.id}::bigint, ${r.cost}::numeric)`,
    );
    await prisma.$executeRaw`
      UPDATE product_variants AS t SET cost = v.cost
      FROM (VALUES ${Prisma.join(values)}) AS v(id, cost)
      WHERE t.id = v.id`;
  }
}

(async () => {
  console.log(APPLY ? '>>> CHẾ ĐỘ GHI THẬT' : '>>> chạy thử, không ghi gì');

  const variants = await prisma.productVariant.findMany({
    where: { inventoryItemId: { not: null } },
    select: {
      id: true,
      sku: true,
      cost: true,
      price: true,
      inventoryItemId: true,
    },
  });
  const byInvId = new Map(
    variants.map((v) => [v.inventoryItemId.toString(), v]),
  );
  console.log(`Có ${variants.length} phiên bản mang inventory_item_id.`);

  const toUpdate = [];
  const samples = [];
  let khongCost = 0;
  let daDung = 0;
  let costLonHonGia = 0;
  const ids = [...byInvId.keys()];

  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const batch = ids.slice(i, i + ID_BATCH);
    const j = await api(
      `/admin/inventory_items.json?ids=${batch.join(',')}&limit=${ID_BATCH}`,
    );
    for (const item of j.inventory_items ?? []) {
      const v = byInvId.get(String(item.id));
      if (!v) continue;
      const cost = Number(item.cost_price ?? 0);
      if (!(cost > 0)) {
        khongCost += 1;
        continue;
      }
      if (Number(v.cost) === cost) {
        daDung += 1;
        continue;
      }
      if (cost > Number(v.price)) costLonHonGia += 1;
      if (samples.length < 10) {
        samples.push({
          sku: v.sku,
          cost_cu: Number(v.cost),
          cost_moi: cost,
          gia_ban: Number(v.price),
        });
      }
      toUpdate.push({ id: v.id, cost });
    }
    process.stdout.write(
      `\r  đã hỏi ${Math.min(i + ID_BATCH, ids.length)}/${ids.length}`,
    );
  }
  console.log('');

  console.log(`\nKẾT QUẢ`);
  console.log(`  sẽ cập nhật giá vốn:        ${toUpdate.length}`);
  console.log(`  đã đúng sẵn:                ${daDung}`);
  console.log(`  Sapo không có giá vốn (>0): ${khongCost}`);
  console.log(`  CẢNH BÁO giá vốn > giá bán: ${costLonHonGia}`);

  console.log(`\nMẪU ĐỂ ĐỐI CHIẾU TAY VỚI GIAO DIỆN SAPO:`);
  for (const s of samples) {
    console.log(
      `  ${s.sku.padEnd(24)} ${String(s.cost_cu).padStart(10)} → ` +
        `${String(s.cost_moi).padStart(12)}   (giá bán ${s.gia_ban})`,
    );
  }

  await flush(toUpdate);

  if (APPLY) {
    const con = await prisma.productVariant.count({ where: { cost: 0 } });
    console.log(`\nĐã ghi. Còn ${con} phiên bản có cost = 0.`);
  } else {
    console.log(`\nChưa ghi gì. Thêm --apply để cập nhật.`);
  }
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
