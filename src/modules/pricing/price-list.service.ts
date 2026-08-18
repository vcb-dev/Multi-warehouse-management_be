import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessException } from '../../common/exceptions/business.exception';
import { assertLocationPermission } from '../../common/auth/access';
import type { AuthUser } from '../../common/decorators/current-user.decorator';

export type ResolveContext = {
  location_id?: bigint;
  customer_group_id?: bigint;
};

export type CreatePriceListDto = {
  code: string;
  name: string;
  location_id?: string;
  customer_group_id?: string;
  items?: {
    variant_id: string;
    fixed_price: number;
    compare_at_price?: number;
    enabled?: boolean;
  }[];
};

@Injectable()
export class PriceListService {
  constructor(private prisma: PrismaService) {}

  async list() {
    const rows = await this.prisma.priceList.findMany({
      include: { _count: { select: { items: true } } },
      orderBy: { code: 'asc' },
    });
    return {
      data: rows.map((r) => ({
        id: r.id.toString(),
        code: r.code,
        name: r.name,
        location_id: r.locationId?.toString() ?? null,
        customer_group_id: r.customerGroupId?.toString() ?? null,
        item_count: r._count.items,
      })),
    };
  }

  async create(dto: CreatePriceListDto) {
    const existing = await this.prisma.priceList.findUnique({
      where: { code: dto.code.trim() },
    });
    if (existing) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Mã bảng giá đã tồn tại',
        422,
      );
    }

    const row = await this.prisma.priceList.create({
      data: {
        code: dto.code.trim(),
        name: dto.name.trim(),
        locationId: dto.location_id ? BigInt(dto.location_id) : null,
        customerGroupId: dto.customer_group_id
          ? BigInt(dto.customer_group_id)
          : null,
        items: dto.items?.length
          ? {
              create: dto.items.map((i) => ({
                variantId: BigInt(i.variant_id),
                fixedPrice: i.fixed_price,
                compareAtPrice: i.compare_at_price,
                enabled: i.enabled ?? true,
              })),
            }
          : undefined,
      },
    });

    return { id: row.id.toString() };
  }

  /** P-3: nhóm khách → chi nhánh → giá variant */
  async resolvePrice(variantId: bigint, ctx: ResolveContext) {
    const variant = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
    });
    if (!variant) throw new NotFoundException('Không tìm thấy phiên bản');

    if (ctx.customer_group_id) {
      const item = await this.findEnabledItem({
        variantId,
        customerGroupId: ctx.customer_group_id,
      });
      if (item) {
        return {
          price: Number(item.fixedPrice),
          source: 'customer_group' as const,
        };
      }
    }

    if (ctx.location_id) {
      const item = await this.findEnabledItem({
        variantId,
        locationId: ctx.location_id,
      });
      if (item) {
        return { price: Number(item.fixedPrice), source: 'branch' as const };
      }
    }

    return {
      price: Number(variant.price),
      source: 'variant_default' as const,
    };
  }

  async resolveQuery(
    variantId: string,
    locationId?: string,
    customerGroupId?: string,
  ) {
    return this.resolvePrice(BigInt(variantId), {
      location_id: locationId ? BigInt(locationId) : undefined,
      customer_group_id: customerGroupId ? BigInt(customerGroupId) : undefined,
    });
  }

  async findOne(id: bigint) {
    const row = await this.prisma.priceList.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            variant: {
              select: { sku: true, product: { select: { name: true } } },
            },
          },
          orderBy: { id: 'asc' },
        },
      },
    });
    if (!row) throw new NotFoundException('Không tìm thấy bảng giá');
    return {
      data: {
        id: row.id.toString(),
        code: row.code,
        name: row.name,
        location_id: row.locationId?.toString() ?? null,
        customer_group_id: row.customerGroupId?.toString() ?? null,
        items: row.items.map((i) => ({
          id: i.id.toString(),
          variant_id: i.variantId.toString(),
          sku: i.variant.sku,
          product_name: i.variant.product.name,
          fixed_price: Number(i.fixedPrice),
          compare_at_price: i.compareAtPrice ? Number(i.compareAtPrice) : null,
          enabled: i.enabled,
        })),
      },
    };
  }

  async upsertItems(
    id: bigint,
    items: {
      variant_id: string;
      fixed_price: number;
      compare_at_price?: number;
      enabled?: boolean;
    }[],
    user: AuthUser,
  ) {
    const priceList = await this.prisma.priceList.findUniqueOrThrow({
      where: { id },
    });

    // Kho nằm trên BẢN GHI chứ không có trong request (id ở path, body chỉ có items),
    // nên PermissionGuard không kiểm được — `@LocationOptional` ở route này chỉ mở
    // đường cho bảng giá toàn cục. Không chốt ở đây thì người có `product:manage` tại
    // kho A sửa được giá của bảng giá thuộc kho B.
    if (priceList.locationId) {
      assertLocationPermission(user, 'product:manage', priceList.locationId);
    }

    await this.prisma.$transaction(async (tx) => {
      for (const item of items) {
        const variantId = BigInt(item.variant_id);
        await tx.priceListItem.upsert({
          where: {
            priceListId_variantId: { priceListId: id, variantId },
          },
          create: {
            priceListId: id,
            variantId,
            fixedPrice: item.fixed_price,
            compareAtPrice: item.compare_at_price,
            enabled: item.enabled ?? true,
          },
          update: {
            fixedPrice: item.fixed_price,
            compareAtPrice: item.compare_at_price,
            enabled: item.enabled ?? true,
          },
        });
      }
    });

    return this.findOne(id);
  }

  private async findEnabledItem(filters: {
    variantId: bigint;
    locationId?: bigint;
    customerGroupId?: bigint;
  }) {
    const lists = await this.prisma.priceList.findMany({
      where: {
        ...(filters.locationId ? { locationId: filters.locationId } : {}),
        ...(filters.customerGroupId
          ? { customerGroupId: filters.customerGroupId }
          : {}),
      },
    });
    if (!lists.length) return null;

    return this.prisma.priceListItem.findFirst({
      where: {
        priceListId: { in: lists.map((l) => l.id) },
        variantId: filters.variantId,
        enabled: true,
      },
      orderBy: { id: 'asc' },
    });
  }
}
