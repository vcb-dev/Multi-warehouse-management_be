/**
 * Thêm những PHIÊN BẢN có trên Sapo mà DB còn thiếu, với sản phẩm ĐÃ CÓ trong DB.
 *
 * Khác `backfill-missing-products.js` (kéo cả sản phẩm chưa từng có): ở đây sản
 * phẩm đã tồn tại, chỉ thiếu một vài phiên bản — thường là phiên bản được thêm
 * trên Sapo sau lần đồng bộ sản phẩm. Hệ quả: dòng hàng của đơn trỏ tới phiên
 * bản đó bị bỏ khi đồng bộ đơn.
 *
 * Chạy thử:  node scripts/backfill-missing-variants.js
 * Ghi thật:  node scripts/backfill-missing-variants.js --apply
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

const variantData = (v, productId, i) => ({
  productId,
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
});

(async () => {
  console.log(APPLY ? '>>> CHẾ ĐỘ GHI THẬT' : '>>> chạy thử, không ghi gì');

  const products = await prisma.product.findMany({
    where: { sapoId: { not: null } },
    select: { id: true, sapoId: true },
  });
  const localProduct = new Map(products.map((p) => [p.sapoId.toString(), p.id]));

  const localVariant = new Set(
    (
      await prisma.productVariant.findMany({
        where: { sapoId: { not: null } },
        select: { sapoId: true },
      })
    ).map((v) => v.sapoId.toString()),
  );

  const toCreate = [];
  const boQuaKhongCoSanPham = [];
  const boQuaTrungSku = [];
  let scanned = 0;

  for (let page = 1; ; page++) {
    const j = await api(`/admin/products.json?page=${page}&limit=250`);
    const ps = j.products ?? [];
    if (!ps.length) break;

    for (const p of ps) {
      const productId = localProduct.get(String(p.id));
      for (const [i, v] of (p.variants ?? []).entries()) {
        scanned += 1;
        if (localVariant.has(String(v.id))) continue;
        if (!productId) {
          boQuaKhongCoSanPham.push({ sapo_product_id: p.id, sku: v.sku });
          continue;
        }
        toCreate.push({ row: variantData(v, productId, i), sku: v.sku });
      }
    }
    process.stdout.write(`\r  quét ${scanned} phiên bản Sapo`);
    if (ps.length < 250) break;
  }
  console.log('');

  // SKU là UNIQUE toàn hệ thống — bỏ phiên bản có SKU đã dùng để không vỡ ràng buộc.
  if (toCreate.length) {
    const skus = toCreate.map((t) => t.sku).filter(Boolean);
    const dung = new Set(
      (
        await prisma.productVariant.findMany({
          where: { sku: { in: skus } },
          select: { sku: true },
        })
      ).map((v) => v.sku),
    );
    for (let i = toCreate.length - 1; i >= 0; i--) {
      if (!toCreate[i].sku || dung.has(toCreate[i].sku)) {
        boQuaTrungSku.push(toCreate[i].sku);
        toCreate.splice(i, 1);
      }
    }
  }

  console.log(`\nKẾT QUẢ`);
  console.log(`  phiên bản sẽ thêm:            ${toCreate.length}`);
  console.log(`  bỏ vì SKU đã tồn tại:         ${boQuaTrungSku.length}`);
  console.log(`  bỏ vì sản phẩm chưa có trong DB: ${boQuaKhongCoSanPham.length}`);
  for (const t of toCreate.slice(0, 30)) console.log(`    + ${t.sku}`);
  if (boQuaKhongCoSanPham.length) {
    console.log(`  → chạy backfill-missing-products.js trước cho nhóm này.`);
  }

  if (APPLY && toCreate.length) {
    await prisma.productVariant.createMany({ data: toCreate.map((t) => t.row) });
    console.log(`\nĐã thêm ${toCreate.length} phiên bản.`);
  } else if (!APPLY) {
    console.log(`\nChưa ghi gì. Thêm --apply để tạo phiên bản.`);
  }
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
