import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import {
  assertLocationPermission,
  locationScopeFilter,
} from '../../common/auth/access';
import { findVariantIdsByQuery } from '../../common/search/unaccent-search';
import { ListInventoryQueryDto, ListMovementsQueryDto } from './inventory.dto';
import { serializeLevel, serializeMovement } from './inventory.serializer';
import {
  InventoryNxtService,
  NxtRowInput,
  rootProductCode,
} from './inventory-nxt.service';

const LOW_STOCK_THRESHOLD = Number(process.env.LOW_STOCK_THRESHOLD ?? 5);

function parseVariantIds(value?: string): bigint[] | undefined {
  if (!value?.trim()) return undefined;
  const ids = value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => BigInt(v));
  return ids.length ? ids : undefined;
}

function appendAnd<W extends { AND?: unknown }>(
  where: W,
  clause: object,
): void {
  (where as { AND?: unknown[] }).AND = [
    ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
    clause,
  ];
}

@Injectable()
export class InventoryQueryService {
  constructor(
    private prisma: PrismaService,
    private nxt: InventoryNxtService,
  ) {}

  /** Gộp extras NXT vào các dòng đã serialize (khóa `${variant_id}:${location_id}`) */
  private async withNxtExtras<
    T extends {
      variant_id: string;
      location_id: string;
      product_id: string;
      sku: string;
      on_hand: number;
      committed: number;
    },
  >(rows: T[], query: ListInventoryQueryDto) {
    const from = query.date_from ? new Date(query.date_from) : undefined;
    const inputs: NxtRowInput[] = rows.map((r) => ({
      variantId: BigInt(r.variant_id),
      locationId: BigInt(r.location_id),
      productId: BigInt(r.product_id),
      onHand: r.on_hand,
      committed: r.committed,
    }));
    const extras = await this.nxt.enrich(inputs, from);
    return rows.map((r) => ({
      ...r,
      ma_sp: rootProductCode(r.sku),
      ...extras.get(`${r.variant_id}:${r.location_id}`)!,
    }));
  }

  async listInventory(query: ListInventoryQueryDto, user: AuthUser) {
    if (query.location_id) {
      return this.listByWarehouse(query, user);
    }
    return this.listExistingLevels(query, user);
  }

  /** Lấy toàn bộ dòng khớp filter (không phân trang) — dùng cho Xuất file */
  async exportRows(query: ListInventoryQueryDto, user: AuthUser) {
    const unpaginated = { ...query, page: 1, page_size: 100000 };
    const { data } = query.location_id
      ? await this.listByWarehouse(unpaginated, user)
      : await this.listExistingLevels(unpaginated, user);
    return data;
  }

  private async listExistingLevels(
    query: ListInventoryQueryDto,
    user: AuthUser,
  ) {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const where = await this.buildLevelWhere(query, user);

    const [rows, total] = await Promise.all([
      this.prisma.inventoryLevel.findMany({
        where,
        include: {
          variant: { include: { product: true } },
          location: true,
        },
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: [{ location: { code: 'asc' } }, { variant: { sku: 'asc' } }],
      }),
      this.prisma.inventoryLevel.count({ where }),
    ]);

    return {
      data: await this.withNxtExtras(rows.map(serializeLevel), query),
      total,
      page,
      page_size: pageSize,
    };
  }

  /** Khi chọn kho: hiển thị mọi variant (kể cả chưa có inventory_level) */
  private async listByWarehouse(query: ListInventoryQueryDto, user: AuthUser) {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const locationId = BigInt(query.location_id!);
    // Nhánh này bỏ qua buildLevelWhere nên không được thừa hưởng bộ lọc kho —
    // thiếu dòng này thì `?location_id=` xem được tồn của kho bất kỳ.
    assertLocationPermission(user, 'inventory:view', locationId);

    const location = await this.prisma.location.findUniqueOrThrow({
      where: { id: locationId },
    });

    const variantWhere = await this.buildVariantWhere(query, locationId);

    const [variants, total] = await Promise.all([
      this.prisma.productVariant.findMany({
        where: variantWhere,
        include: {
          product: true,
          inventoryLevels: { where: { locationId } },
        },
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { sku: 'asc' },
      }),
      this.prisma.productVariant.count({ where: variantWhere }),
    ]);

    const data = variants.map((v) => {
      const level = v.inventoryLevels[0];
      if (level) {
        return serializeLevel({
          ...level,
          variant: v,
          location,
        });
      }
      return {
        variant_id: v.id.toString(),
        location_id: locationId.toString(),
        product_id: v.productId.toString(),
        sku: v.sku,
        product_name: v.product.name,
        image_url: v.imageUrl ?? v.product.imageUrl ?? null,
        unit: v.unit ?? null,
        location_code: location.code,
        location_name: location.name,
        on_hand: 0,
        committed: 0,
        packed: 0,
        unavailable: 0,
        incoming: 0,
        available: 0,
        price: v.price.toString(),
        cost: v.cost.toString(),
        updated_at: new Date(0).toISOString(),
      };
    });

    return {
      data: await this.withNxtExtras(data, query),
      total,
      page,
      page_size: pageSize,
    };
  }

  private async buildVariantWhere(
    query: ListInventoryQueryDto,
    locationId: bigint,
  ): Promise<Prisma.ProductVariantWhereInput> {
    const where: Prisma.ProductVariantWhereInput = {};

    if (query.variant_id) {
      where.id = BigInt(query.variant_id);
    }

    const variantIds = parseVariantIds(query.variant_ids);
    if (variantIds) {
      where.id = { in: variantIds };
    }

    if (query.q?.trim()) {
      const ids = await findVariantIdsByQuery(this.prisma, query.q.trim());
      appendAnd(where, { id: { in: ids } });
    }

    if (query.low_stock) {
      appendAnd(where, {
        OR: [
          { inventoryLevels: { none: { locationId } } },
          {
            inventoryLevels: {
              some: { locationId, available: { lte: LOW_STOCK_THRESHOLD } },
            },
          },
        ],
      });
    }

    if (query.stock_status === 'in_stock') {
      appendAnd(where, {
        inventoryLevels: { some: { locationId, available: { gt: 0 } } },
      });
    } else if (query.stock_status === 'out_of_stock') {
      appendAnd(where, {
        OR: [
          { inventoryLevels: { none: { locationId } } },
          { inventoryLevels: { some: { locationId, available: { lte: 0 } } } },
        ],
      });
    } else if (query.stock_status === 'negative') {
      // Âm THẬT (< 0), không gộp dòng bằng 0 như out_of_stock — và không lấy dòng
      // chưa có bản ghi tồn ở kho này (chưa nhập bao giờ, không phải âm kho).
      appendAnd(where, {
        inventoryLevels: { some: { locationId, available: { lt: 0 } } },
      });
    }

    return where;
  }

  async listMovements(
    variantId: bigint,
    query: ListMovementsQueryDto,
    user: AuthUser,
  ) {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const where: Prisma.InventoryMovementWhereInput = { variantId };

    if (query.location_id) {
      const locationId = BigInt(query.location_id);
      assertLocationPermission(user, 'inventory:view', locationId);
      where.locationId = locationId;
    } else {
      where.locationId = locationScopeFilter(user, 'inventory:view');
    }

    if (query.bucket) where.bucket = query.bucket;

    if (query.from || query.to) {
      where.createdAt = {};
      if (query.from) where.createdAt.gte = new Date(query.from);
      if (query.to) where.createdAt.lte = new Date(query.to);
    }

    const [rows, total] = await Promise.all([
      this.prisma.inventoryMovement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.inventoryMovement.count({ where }),
    ]);

    return {
      data: rows.map(serializeMovement),
      total,
      page,
      page_size: pageSize,
    };
  }

  private async buildLevelWhere(
    query: ListInventoryQueryDto,
    user: AuthUser,
  ): Promise<Prisma.InventoryLevelWhereInput> {
    const where: Prisma.InventoryLevelWhereInput = {};

    where.locationId = locationScopeFilter(user, 'inventory:view');

    if (query.variant_id) {
      where.variantId = BigInt(query.variant_id);
    }

    const variantIds = parseVariantIds(query.variant_ids);
    if (variantIds) {
      where.variantId = { in: variantIds };
    }

    if (query.low_stock) {
      where.available = { lte: LOW_STOCK_THRESHOLD };
    }

    if (query.stock_status === 'in_stock') {
      where.available = { gt: 0 };
    } else if (query.stock_status === 'out_of_stock') {
      where.available = { lte: 0 };
    } else if (query.stock_status === 'negative') {
      where.available = { lt: 0 };
    }

    if (query.q?.trim()) {
      const ids = await findVariantIdsByQuery(this.prisma, query.q.trim());
      appendAnd(where, { variantId: { in: ids } });
    }

    return where;
  }
}
