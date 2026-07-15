import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { findVariantIdsByQuery } from '../../common/search/unaccent-search';
import { ListInventoryQueryDto, ListMovementsQueryDto } from './inventory.dto';
import { serializeLevel, serializeMovement } from './inventory.serializer';

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
  constructor(private prisma: PrismaService) {}

  async listInventory(query: ListInventoryQueryDto, user: AuthUser) {
    if (query.warehouse_id) {
      return this.listByWarehouse(query, user);
    }
    return this.listExistingLevels(query, user);
  }

  /** Lấy toàn bộ dòng khớp filter (không phân trang) — dùng cho Xuất file */
  async exportRows(query: ListInventoryQueryDto, user: AuthUser) {
    const unpaginated = { ...query, page: 1, page_size: 100000 };
    const { data } = query.warehouse_id
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
          warehouse: true,
        },
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: [{ warehouse: { code: 'asc' } }, { variant: { sku: 'asc' } }],
      }),
      this.prisma.inventoryLevel.count({ where }),
    ]);

    return {
      data: rows.map(serializeLevel),
      total,
      page,
      page_size: pageSize,
    };
  }

  /** Khi chọn kho: hiển thị mọi variant (kể cả chưa có inventory_level) */
  private async listByWarehouse(query: ListInventoryQueryDto, user: AuthUser) {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const warehouseId = BigInt(query.warehouse_id!);

    const warehouse = await this.prisma.warehouse.findUniqueOrThrow({
      where: { id: warehouseId },
    });

    const variantWhere = await this.buildVariantWhere(query, warehouseId);

    const [variants, total] = await Promise.all([
      this.prisma.productVariant.findMany({
        where: variantWhere,
        include: {
          product: true,
          inventoryLevels: { where: { warehouseId } },
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
          warehouse,
        });
      }
      return {
        variant_id: v.id.toString(),
        warehouse_id: warehouseId.toString(),
        product_id: v.productId.toString(),
        sku: v.sku,
        product_name: v.product.name,
        image_url: v.imageUrl ?? v.product.imageUrl ?? null,
        unit: v.product.unit ?? null,
        warehouse_code: warehouse.code,
        warehouse_name: warehouse.name,
        on_hand: 0,
        committed: 0,
        packing: 0,
        unavailable: 0,
        incoming: 0,
        available: 0,
        price: v.price.toString(),
        cost: v.cost.toString(),
        updated_at: new Date(0).toISOString(),
      };
    });

    return { data, total, page, page_size: pageSize };
  }

  private async buildVariantWhere(
    query: ListInventoryQueryDto,
    warehouseId: bigint,
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
          { inventoryLevels: { none: { warehouseId } } },
          {
            inventoryLevels: {
              some: { warehouseId, available: { lte: LOW_STOCK_THRESHOLD } },
            },
          },
        ],
      });
    }

    if (query.stock_status === 'in_stock') {
      appendAnd(where, {
        inventoryLevels: { some: { warehouseId, available: { gt: 0 } } },
      });
    } else if (query.stock_status === 'out_of_stock') {
      appendAnd(where, {
        OR: [
          { inventoryLevels: { none: { warehouseId } } },
          { inventoryLevels: { some: { warehouseId, available: { lte: 0 } } } },
        ],
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

    if (query.warehouse_id) {
      where.warehouseId = BigInt(query.warehouse_id);
    } else {
      where.warehouseId = { in: user.warehouseIds };
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

    where.warehouseId = { in: user.warehouseIds };

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
    }

    if (query.q?.trim()) {
      const ids = await findVariantIdsByQuery(this.prisma, query.q.trim());
      appendAnd(where, { variantId: { in: ids } });
    }

    return where;
  }

  async listLots(
    query: {
      variant_id?: string;
      warehouse_id?: string;
      q?: string;
      page?: number;
      page_size?: number;
    },
    user: AuthUser,
  ) {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;

    const where: Prisma.LotWhereInput = {};
    if (query.variant_id) {
      where.variantId = BigInt(query.variant_id);
    }
    if (query.warehouse_id) {
      where.variant = {
        inventoryLevels: { some: { warehouseId: BigInt(query.warehouse_id) } },
      };
    } else {
      where.variant = {
        inventoryLevels: { some: { warehouseId: { in: user.warehouseIds } } },
      };
    }
    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [
        { code: { contains: q, mode: 'insensitive' } },
        { variant: { sku: { contains: q, mode: 'insensitive' } } },
        {
          variant: { product: { name: { contains: q, mode: 'insensitive' } } },
        },
      ];
    }

    const [rows, total, sums] = await Promise.all([
      this.prisma.lot.findMany({
        where,
        include: { variant: { include: { product: true } } },
        orderBy: [{ expiredAt: 'asc' }, { code: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.lot.count({ where }),
      this.prisma.inventoryMovement.groupBy({
        by: ['lotId'],
        where: { lotId: { not: null }, bucket: 'on_hand' },
        _sum: { change: true },
      }),
    ]);

    const qtyByLot = new Map(
      sums.map((s) => [s.lotId!.toString(), s._sum.change ?? 0]),
    );

    return {
      data: rows.map((l) => ({
        id: l.id.toString(),
        code: l.code,
        variant_id: l.variantId.toString(),
        sku: l.variant.sku,
        product_name: l.variant.product.name,
        quantity: qtyByLot.get(l.id.toString()) ?? 0,
        manufactured_at: l.manufacturedAt?.toISOString().slice(0, 10) ?? null,
        expired_at: l.expiredAt?.toISOString().slice(0, 10) ?? null,
      })),
      total,
      page,
      page_size: pageSize,
    };
  }

  async listLotsForVariant(variantId: bigint) {
    const rows = await this.prisma.lot.findMany({
      where: { variantId },
      orderBy: [{ expiredAt: 'asc' }, { code: 'asc' }],
    });
    return {
      data: rows.map((l) => ({
        id: l.id.toString(),
        code: l.code,
        variant_id: l.variantId.toString(),
        manufactured_at: l.manufacturedAt?.toISOString().slice(0, 10) ?? null,
        expired_at: l.expiredAt?.toISOString().slice(0, 10) ?? null,
      })),
    };
  }
}
