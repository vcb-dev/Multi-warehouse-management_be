import { PrismaService } from '../../prisma/prisma.service';

/**
 * Search không phân biệt dấu tiếng Việt (unaccent) — Prisma's `contains`/`ILIKE`
 * chỉ bỏ qua hoa/thường, không bỏ dấu, nên phải dùng raw SQL với extension
 * `unaccent` của Postgres (bật ở migration `enable_unaccent_extension`).
 */

/** Product.id khớp tên, nhãn hiệu, hoặc SKU của 1 trong các biến thể */
export async function findProductIdsByQuery(
  prisma: PrismaService,
  q: string,
): Promise<bigint[]> {
  const pattern = `%${q}%`;
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT DISTINCT p.id
    FROM products p
    LEFT JOIN product_variants v ON v.product_id = p.id
    WHERE unaccent(p.name) ILIKE unaccent(${pattern})
       OR unaccent(COALESCE(p.brand, '')) ILIKE unaccent(${pattern})
       OR unaccent(v.sku) ILIKE unaccent(${pattern})
  `;
  return rows.map((r) => r.id);
}

/** ProductVariant.id khớp SKU của chính nó hoặc tên sản phẩm */
export async function findVariantIdsByQuery(
  prisma: PrismaService,
  q: string,
): Promise<bigint[]> {
  const pattern = `%${q}%`;
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT v.id
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    WHERE unaccent(v.sku) ILIKE unaccent(${pattern})
       OR unaccent(p.name) ILIKE unaccent(${pattern})
  `;
  return rows.map((r) => r.id);
}
