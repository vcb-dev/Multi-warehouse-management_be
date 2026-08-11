/**
 * Backfill liên kết sản phẩm ⇄ danh mục (Sapo `collects`) — bảng
 * `product_categories` hiện gần như trống (5 dòng) dù Sapo có 3.655 collect,
 * vì chưa có script nào từng gọi `/admin/collects.json`.
 *
 * Chạy: node scripts/backfill-sapo-collects.js [--apply]
 *
 * Tổng số collect nhỏ (~3.6k, dưới trần page*limit<=30000 của Sapo) nên không
 * cần chia cửa sổ theo ngày như customers/orders.
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

(async () => {
  console.log(APPLY ? '=== GHI DỮ LIỆU ===\n' : '=== DRY RUN — không ghi gì ===\n');

  const [products, categories] = await Promise.all([
    prisma.product.findMany({ where: { sapoId: { not: null } }, select: { id: true, sapoId: true } }),
    prisma.category.findMany({ where: { sapoId: { not: null } }, select: { id: true, sapoId: true } }),
  ]);
  const prodBySapo = new Map(products.map((p) => [String(p.sapoId), p.id]));
  const catBySapo = new Map(categories.map((c) => [String(c.sapoId), c.id]));
  console.log(`Sản phẩm có sapo_id: ${products.length} | Danh mục có sapo_id: ${categories.length}\n`);

  let page = 1;
  let seen = 0;
  let linked = 0;
  let skipNoProduct = 0;
  let skipNoCategory = 0;

  while (page * 250 <= 30000) {
    const j = await api(`/admin/collects.json?limit=250&page=${page}`);
    const list = j.collects ?? [];
    if (!list.length) break;
    seen += list.length;

    for (const c of list) {
      const productId = prodBySapo.get(String(c.product_id));
      const categoryId = catBySapo.get(String(c.collection_id));
      if (!productId) { skipNoProduct += 1; continue; }
      if (!categoryId) { skipNoCategory += 1; continue; }
      linked += 1;

      if (APPLY) {
        await prisma.productCategory.upsert({
          where: { productId_categoryId: { productId, categoryId } },
          update: { position: c.position ?? 0, featured: !!c.featured },
          create: {
            productId,
            categoryId,
            position: c.position ?? 0,
            featured: !!c.featured,
            createdOn: c.created_on ? new Date(c.created_on) : new Date(),
          },
        });
      }
    }

    console.log(`  trang ${page}: ${seen} collect quét, ${linked} liên kết`);
    if (list.length < 250) break;
    page += 1;
  }

  console.log('\n=== KẾT QUẢ ===');
  console.log(`collect quét: ${seen}`);
  console.log(`liên kết ghi: ${linked} (bỏ qua thiếu sản phẩm: ${skipNoProduct}, thiếu danh mục: ${skipNoCategory})`);
  if (!APPLY) console.log('\n(chạy lại với --apply để ghi)');

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('LỖI:', e);
  await prisma.$disconnect();
  process.exit(1);
});
