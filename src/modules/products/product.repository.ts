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

  get client() {
    return this.prisma;
  }
}

export { productInclude };
