import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const productInclude = {
  images: { orderBy: { position: 'asc' as const } },
  options: { orderBy: { position: 'asc' as const } },
  variants: {
    include: {
      optionValues: { include: { option: true } },
    },
    orderBy: { id: 'asc' as const },
  },
  salesChannels: true,
  categories: { include: { category: true } },
} satisfies Prisma.ProductInclude;

export type ProductWithRelations = Prisma.ProductGetPayload<{
  include: typeof productInclude;
}>;

@Injectable()
export class ProductRepository {
  constructor(private prisma: PrismaService) {}

  findMany(args: Prisma.ProductFindManyArgs) {
    return this.prisma.product.findMany(args);
  }

  count(where: Prisma.ProductWhereInput) {
    return this.prisma.product.count({ where });
  }

  findById(id: bigint) {
    return this.prisma.product.findUnique({
      where: { id },
      include: productInclude,
    });
  }

  findByAlias(alias: string) {
    return this.prisma.product.findUnique({ where: { alias } });
  }

  findVariantBySku(sku: string) {
    return this.prisma.productVariant.findUnique({ where: { sku } });
  }

  async variantIdsWithInventory(
    db: PrismaService | Prisma.TransactionClient,
    variantIds: bigint[],
  ): Promise<Set<bigint>> {
    if (!variantIds.length) return new Set();

    const rows = await db.inventoryLevel.groupBy({
      by: ['variantId'],
      where: { variantId: { in: variantIds } },
      _sum: { onHand: true, committed: true, incoming: true },
    });

    const inUse = new Set<bigint>();
    for (const row of rows) {
      const total =
        (row._sum.onHand ?? 0) +
        (row._sum.committed ?? 0) +
        (row._sum.incoming ?? 0);
      if (total > 0) inUse.add(row.variantId);
    }
    return inUse;
  }

  async variantIdsReferencedInDocuments(
    db: PrismaService | Prisma.TransactionClient,
    variantIds: bigint[],
  ): Promise<Set<bigint>> {
    if (!variantIds.length) return new Set();

    const [
      orderItems,
      draftItems,
      poItems,
      receiptItems,
      transferItems,
      returnItems,
      orderReturnItems,
      movements,
    ] = await Promise.all([
      db.orderItem.findMany({
        where: { variantId: { in: variantIds } },
        select: { variantId: true },
        distinct: ['variantId'],
      }),
      db.draftOrderItem.findMany({
        where: { variantId: { in: variantIds } },
        select: { variantId: true },
        distinct: ['variantId'],
      }),
      db.purchaseOrderItem.findMany({
        where: { variantId: { in: variantIds } },
        select: { variantId: true },
        distinct: ['variantId'],
      }),
      db.goodsReceiptItem.findMany({
        where: { variantId: { in: variantIds } },
        select: { variantId: true },
        distinct: ['variantId'],
      }),
      db.stockTransferItem.findMany({
        where: { variantId: { in: variantIds } },
        select: { variantId: true },
        distinct: ['variantId'],
      }),
      db.purchaseReturnItem.findMany({
        where: { variantId: { in: variantIds } },
        select: { variantId: true },
        distinct: ['variantId'],
      }),
      db.orderRefundLineItem.findMany({
        where: { variantId: { in: variantIds } },
        select: { variantId: true },
        distinct: ['variantId'],
      }),
      db.inventoryMovement.findMany({
        where: { variantId: { in: variantIds } },
        select: { variantId: true },
        distinct: ['variantId'],
      }),
    ]);

    const refs = new Set<bigint>();
    for (const rows of [
      orderItems,
      draftItems,
      poItems,
      receiptItems,
      transferItems,
      returnItems,
      orderReturnItems,
      movements,
    ]) {
      for (const row of rows) refs.add(row.variantId);
    }
    return refs;
  }

  async variantIdsBlockedFromDelete(
    db: PrismaService | Prisma.TransactionClient,
    variantIds: bigint[],
  ): Promise<Set<bigint>> {
    const [withStock, referenced] = await Promise.all([
      this.variantIdsWithInventory(db, variantIds),
      this.variantIdsReferencedInDocuments(db, variantIds),
    ]);
    return new Set([...withStock, ...referenced]);
  }

  async deleteVariants(
    db: PrismaService | Prisma.TransactionClient,
    variantIds: bigint[],
  ): Promise<void> {
    if (!variantIds.length) return;

    await db.inventoryLevel.deleteMany({
      where: { variantId: { in: variantIds } },
    });
    await db.priceListItem.deleteMany({
      where: { variantId: { in: variantIds } },
    });
    await db.productVariant.deleteMany({
      where: { id: { in: variantIds } },
    });
  }

  async variantHasInventory(variantId: bigint) {
    const inUse = await this.variantIdsWithInventory(this.prisma, [variantId]);
    return inUse.has(variantId);
  }

  /**
   * Danh sách tag đang dùng, kèm số sản phẩm — nguồn gợi ý cho ô chọn tag.
   * Không có bảng tag riêng (tag của Sapo về thẳng `products.tags`), nên phải
   * `unnest` mảng rồi gom nhóm bằng raw SQL; Prisma không làm được việc này.
   */
  async listTags(params: { q?: string; limit: number }) {
    const pattern = params.q ? `%${params.q}%` : null;
    return this.prisma.$queryRaw<{ tag: string; product_count: bigint }[]>`
      SELECT t AS tag, count(*) AS product_count
      FROM products p, unnest(p.tags) AS t
      WHERE t <> ''
        AND (
          ${pattern}::text IS NULL
          OR unaccent(t) ILIKE unaccent(${pattern}::text)
        )
      GROUP BY t
      ORDER BY count(*) DESC, t ASC
      LIMIT ${params.limit}
    `;
  }

  /**
   * Loại sản phẩm đang dùng, kèm số sản phẩm — nguồn gợi ý cho ô chọn loại.
   * Cũng như tag, `product_type` là chuỗi tự do đồng bộ từ Sapo chứ không có
   * bảng danh mục riêng, nên danh sách phải gom từ chính bảng products.
   */
  async listProductTypes(params: { q?: string; limit: number }) {
    const pattern = params.q ? `%${params.q}%` : null;
    return this.prisma.$queryRaw<
      { product_type: string; product_count: bigint }[]
    >`
      SELECT product_type, count(*) AS product_count
      FROM products
      WHERE product_type IS NOT NULL
        AND product_type <> ''
        AND (
          ${pattern}::text IS NULL
          OR unaccent(product_type) ILIKE unaccent(${pattern}::text)
        )
      GROUP BY product_type
      ORDER BY count(*) DESC, product_type ASC
      LIMIT ${params.limit}
    `;
  }

  /**
   * Nhãn hiệu đang dùng, kèm số sản phẩm — nguồn gợi ý cho ô chọn nhãn hiệu.
   * Giống loại sản phẩm, `vendor` là chuỗi tự do đồng bộ từ Sapo chứ không có
   * bảng riêng, nên danh sách phải gom thẳng từ bảng products.
   */
  async listVendors(params: { q?: string; limit: number }) {
    const pattern = params.q ? `%${params.q}%` : null;
    return this.prisma.$queryRaw<{ vendor: string; product_count: bigint }[]>`
      SELECT vendor, count(*) AS product_count
      FROM products
      WHERE vendor IS NOT NULL
        AND vendor <> ''
        AND (
          ${pattern}::text IS NULL
          OR unaccent(vendor) ILIKE unaccent(${pattern}::text)
        )
      GROUP BY vendor
      ORDER BY count(*) DESC, vendor ASC
      LIMIT ${params.limit}
    `;
  }

  get client() {
    return this.prisma;
  }
}

export { productInclude };
