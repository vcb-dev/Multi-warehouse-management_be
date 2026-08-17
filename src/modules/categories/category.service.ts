import { Injectable, NotFoundException } from '@nestjs/common';
import { CategoryConditionType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessException } from '../../common/exceptions/business.exception';
import { slugify } from '../products/product.serializer';
import { type AutoConditions, CreateCategoryDto } from './category.dto';

export type { AutoConditions, CreateCategoryDto };

/** Số id mỗi lô khi gán/gỡ danh mục auto hàng loạt. */
const AUTO_WRITE_CHUNK = 1000;

export type CategoryTreeNode = {
  id: string;
  name: string;
  alias: string;
  parent_id: string | null;
  description: string | null;
  condition_type: CategoryConditionType;
  rules: AutoConditions | null;
  sales_channels: string[];
  image_src: string | null;
  products_count: number;
  children: CategoryTreeNode[];
};

@Injectable()
export class CategoryService {
  constructor(private prisma: PrismaService) {}

  async listTree() {
    const rows = await this.prisma.category.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true } } },
    });
    return { data: this.buildTree(rows) };
  }

  async create(dto: CreateCategoryDto) {
    const alias = await this.uniqueSlug(slugify(dto.name));
    if (dto.parent_id) {
      const parentId = BigInt(dto.parent_id);
      const parent = await this.prisma.category.findUnique({
        where: { id: parentId },
        select: { id: true },
      });
      if (!parent) {
        throw new NotFoundException('Không tìm thấy danh mục cha');
      }
      await this.assertNoCycle(parentId, null);
    }

    const row = await this.prisma.category.create({
      data: {
        name: dto.name.trim(),
        alias,
        description: dto.description?.trim() || null,
        parentId: dto.parent_id ? BigInt(dto.parent_id) : null,
        imageSrc: dto.image_url || null,
        conditionType: dto.condition_type as CategoryConditionType,
        rules: (dto.auto_conditions as AutoConditions | undefined) ?? undefined,
        salesChannels: dto.sales_channels ?? [],
      },
    });

    if (row.conditionType === CategoryConditionType.auto) {
      await this.evaluateAutoForAllProducts();
    }

    return { id: row.id.toString() };
  }

  async assignProducts(categoryId: bigint, productIds: bigint[]) {
    const cat = await this.prisma.category.findUnique({
      where: { id: categoryId },
    });
    if (!cat) throw new NotFoundException('Không tìm thấy danh mục');
    if (cat.conditionType !== CategoryConditionType.manual) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Chỉ danh mục thủ công mới gán SP thủ công',
        422,
      );
    }

    await this.prisma.productCategory.createMany({
      data: productIds.map((productId) => ({ productId, categoryId })),
      skipDuplicates: true,
    });

    return { assigned: productIds.length };
  }

  /** Gán/gỡ danh mục auto cho một SP (P-4) */
  async evaluateAutoForProduct(
    tx: Prisma.TransactionClient,
    productId: bigint,
  ) {
    const product = await tx.product.findUnique({ where: { id: productId } });
    if (!product) return;

    const autoCategories = await tx.category.findMany({
      where: { conditionType: CategoryConditionType.auto },
    });

    for (const cat of autoCategories) {
      const matches = this.matchesAuto(product, cat.rules);
      if (matches) {
        await tx.productCategory.upsert({
          where: {
            productId_categoryId: { productId, categoryId: cat.id },
          },
          create: { productId, categoryId: cat.id },
          update: {},
        });
      } else {
        await tx.productCategory.deleteMany({
          where: { productId, categoryId: cat.id },
        });
      }
    }
  }

  /**
   * Quét lại toàn bộ SP cho mọi danh mục auto.
   *
   * Chạy theo lô: bản cũ mở một transaction cho MỖI sản phẩm, với 12k+ sản phẩm
   * thì một request tạo danh mục auto treo hàng giờ. Vẫn dùng chung
   * `matchesAuto` nên kết quả gán/gỡ không đổi.
   */
  async evaluateAutoForAllProducts() {
    const autoCategories = await this.prisma.category.findMany({
      where: { conditionType: CategoryConditionType.auto },
    });
    if (!autoCategories.length) return;

    const products = await this.prisma.product.findMany({
      select: { id: true, vendor: true, productType: true, tags: true },
    });

    for (const cat of autoCategories) {
      const matched = new Set<bigint>();
      for (const p of products) {
        if (this.matchesAuto(p, cat.rules)) matched.add(p.id);
      }

      const current = await this.prisma.productCategory.findMany({
        where: { categoryId: cat.id },
        select: { productId: true },
      });
      const currentIds = new Set(current.map((r) => r.productId));

      const toAdd = [...matched].filter((id) => !currentIds.has(id));
      const toRemove = [...currentIds].filter((id) => !matched.has(id));

      for (const chunk of this.chunk(toAdd)) {
        await this.prisma.productCategory.createMany({
          data: chunk.map((productId) => ({ productId, categoryId: cat.id })),
          skipDuplicates: true,
        });
      }
      for (const chunk of this.chunk(toRemove)) {
        await this.prisma.productCategory.deleteMany({
          where: { categoryId: cat.id, productId: { in: chunk } },
        });
      }
    }
  }

  /** Cắt lô để câu lệnh không phình quá số tham số Postgres cho phép. */
  private chunk(ids: bigint[], size = AUTO_WRITE_CHUNK): bigint[][] {
    const out: bigint[][] = [];
    for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
    return out;
  }

  matchesAuto(
    product: {
      vendor: string | null;
      productType: string | null;
      tags: string[];
    },
    conditions: unknown,
  ): boolean {
    if (!conditions || typeof conditions !== 'object') return false;
    const c = conditions as AutoConditions;
    if (c.vendor && product.vendor !== c.vendor) return false;
    if (c.product_type && product.productType !== c.product_type) return false;
    if (c.tags?.length) {
      const hasAll = c.tags.every((t) => product.tags.includes(t));
      if (!hasAll) return false;
    }
    return !!(c.vendor || c.product_type || c.tags?.length);
  }

  private buildTree(
    rows: {
      id: bigint;
      name: string;
      parentId: bigint | null;
      conditionType: CategoryConditionType;
      rules: unknown;
      description: string | null;
      salesChannels: string[];
      imageSrc: string | null;
      alias: string;
      _count: { products: number };
    }[],
    parentId: bigint | null = null,
  ): CategoryTreeNode[] {
    return rows
      .filter((r) => r.parentId === parentId)
      .map((r) => ({
        id: r.id.toString(),
        name: r.name,
        alias: r.alias,
        parent_id: r.parentId?.toString() ?? null,
        description: r.description,
        condition_type: r.conditionType,
        rules: (r.rules as AutoConditions | null) ?? null,
        sales_channels: r.salesChannels,
        image_src: r.imageSrc,
        products_count: r._count.products,
        children: this.buildTree(rows, r.id),
      }));
  }

  private async assertNoCycle(parentId: bigint, childId: bigint | null) {
    let current: bigint | null = parentId;
    const seen = new Set<string>();
    while (current) {
      if (childId && current === childId) {
        throw new BusinessException(
          'CATEGORY_CYCLE',
          'Danh mục cha tạo vòng lặp',
          422,
        );
      }
      const key = current.toString();
      if (seen.has(key)) break;
      seen.add(key);
      const row: { parentId: bigint | null } | null =
        await this.prisma.category.findUnique({
          where: { id: current },
          select: { parentId: true },
        });
      current = row?.parentId ?? null;
    }
  }

  private async uniqueSlug(base: string) {
    let slug = base;
    let n = 0;
    while (await this.prisma.category.findUnique({ where: { alias: slug } })) {
      n += 1;
      slug = `${base}-${n}`;
    }
    return slug;
  }
}
