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

  findBySlug(slug: string) {
    return this.prisma.product.findUnique({ where: { slug } });
  }

  findVariantBySku(sku: string) {
    return this.prisma.productVariant.findUnique({ where: { sku } });
  }

  async variantHasInventory(variantId: bigint) {
    const agg = await this.prisma.inventoryLevel.aggregate({
      where: { variantId },
      _sum: { onHand: true, committed: true, incoming: true },
    });
    const total =
      (agg._sum.onHand ?? 0) +
      (agg._sum.committed ?? 0) +
      (agg._sum.incoming ?? 0);
    return total > 0;
  }

  get client() {
    return this.prisma;
  }
}

export { productInclude };
