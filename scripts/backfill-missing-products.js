/**
 * Kéo những sản phẩm chỉ có ở Sapo mà chưa có trong DB (63 sản phẩm),
 * kèm phiên bản + tuỳ chọn.
 *
 * Chạy: node scripts/backfill-missing-products.js [--apply]
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

/** alias phải UNIQUE — thêm hậu tố sapo_id nếu đụng */
async function uniqueAlias(base, sapoId, used) {
  let a = (base || `sp-${sapoId}`).trim() || `sp-${sapoId}`;
  if (!used.has(a) && !(await prisma.product.findUnique({ where: { alias: a } }))) {
    used.add(a);
    return a;
  }
  a = `${a}-${sapoId}`;
  used.add(a);
  return a;
}

/** SKU cũng UNIQUE — bỏ qua phiên bản có SKU đã tồn tại để không phá dữ liệu cũ */
async function filterVariants(variants) {
  const skus = variants.map((v) => v.sku).filter(Boolean);
  if (!skus.length) return { keep: [], dropped: variants.length };
  const existing = new Set(
    (
      await prisma.productVariant.findMany({
        where: { sku: { in: skus } },
        select: { sku: true },
      })
    ).map((v) => v.sku),
  );
  const keep = variants.filter((v) => v.sku && !existing.has(v.sku));
  return { keep, dropped: variants.length - keep.length };
}

/**
 * Tự dò sản phẩm có trên Sapo mà chưa có trong DB (đối chiếu theo `sapo_id`).
 * Vẫn đọc được danh sách dựng sẵn qua --file=<đường dẫn> nếu cần chạy có chọn lọc.
 */
async function findMissing() {
  const fileArg = process.argv.find((a) => a.startsWith('--file='));
  if (fileArg) {
    const path = fileArg.slice('--file='.length);
    return JSON.parse(require('fs').readFileSync(path, 'utf8'));
  }

  const local = new Set(
    (
      await prisma.product.findMany({
        where: { sapoId: { not: null } },
        select: { sapoId: true },
      })
    ).map((p) => p.sapoId.toString()),
  );

  const missing = [];
  let scanned = 0;
  for (let page = 1; ; page++) {
    const j = await api(`/admin/products.json?page=${page}&limit=250`);
    const ps = j.products ?? [];
    if (!ps.length) break;
    for (const p of ps) {
      scanned += 1;
      if (!local.has(String(p.id))) missing.push(p.id);
    }
    process.stdout.write(`\r  quét Sapo: ${scanned} sản phẩm`);
    if (ps.length < 250) break;
  }
  console.log(`\n  Sapo có ${scanned}, DB có ${local.size} (theo sapo_id).`);
  return missing;
}

(async () => {
  const missing = await findMissing();
  console.log(`Sản phẩm cần kéo: ${missing.length}`);

  const usedAlias = new Set();
  let created = 0;
  let variantCount = 0;
  let droppedVariants = 0;
  let skippedNoVariant = 0;
  let failed = 0;

  for (const sapoId of missing) {
    const j = await api(`/admin/products/${sapoId}.json`);
    const s = j?.product;
    if (!s) {
      failed += 1;
      continue;
    }

    const { keep, dropped } = await filterVariants(s.variants ?? []);
    droppedVariants += dropped;

    // Không tạo sản phẩm rỗng phiên bản — đó đúng là lỗi mà audit đang bắt
    // ("sản phẩm nào cũng có ít nhất 1 phiên bản").
    if (!keep.length) {
      skippedNoVariant += 1;
      continue;
    }

    const alias = await uniqueAlias(s.alias, s.id, usedAlias);
    const data = {
      sapoId: BigInt(s.id),
      name: s.name || `SP ${s.id}`,
      alias,
      vendor: s.vendor || null,
      productType: s.product_type || null,
      content: s.content || null,
      summary: s.summary || null,
      metaTitle: s.meta_title || null,
      metaDescription: s.meta_description || null,
      status: s.status || 'draft',
      type: s.type || 'normal',
      tags: s.tags ? s.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      publishedOn: toDate(s.published_on),
      createdOn: toDate(s.created_on) ?? new Date(),
      variants: {
        create: keep.map((v, i) => ({
          sapoId: BigInt(v.id),
          inventoryItemId: v.inventory_item_id ? BigInt(v.inventory_item_id) : null,
          sku: v.sku,
          title: v.title || null,
          barcode: v.barcode || null,
          price: String(v.price ?? 0),
          compareAtPrice: v.compare_at_price != null ? String(v.compare_at_price) : null,
          weight: v.weight != null ? String(v.weight) : null,
          weightUnit: v.weight_unit || null,
          unit: v.unit || null,
          position: v.position ?? i,
          type: v.type || 'normal',
          inventoryManagement: v.inventory_management ?? 'bizweb',
          inventoryPolicy: v.inventory_policy ?? 'deny',
          lotManagement: !!v.lot_management,
          requiresShipping: v.requires_shipping ?? true,
          taxable: v.taxable ?? true,
          requiresComponents: !!v.requires_components,
        })),
      },
    };

    if (!APPLY) {
      created += 1;
      variantCount += keep.length;
      continue;
    }

    try {
      await prisma.product.create({ data });
      created += 1;
      variantCount += keep.length;
      if (created % 20 === 0) console.log(`  ...${created}/${missing.length}`);
    } catch (e) {
      failed += 1;
      console.warn(`  ⚠ ${s.id} (${s.name}): ${e.message.split('\n')[0]}`);
    }
  }

  console.log('\n=== KẾT QUẢ ===');
  console.log(`sản phẩm tạo: ${created} | phiên bản: ${variantCount}`);
  console.log(`bỏ phiên bản trùng SKU: ${droppedVariants} | lỗi: ${failed}`);
  console.log(`bỏ sản phẩm không còn phiên bản nào hợp lệ: ${skippedNoVariant}`);
  if (!APPLY) console.log('\n(chạy lại với --apply để ghi)');

  await prisma.$disconnect();
})();
