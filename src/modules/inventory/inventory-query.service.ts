import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { ListInventoryQueryDto, ListMovementsQueryDto } from './inventory.dto';
import { serializeLevel, serializeMovement } from './inventory.serializer';

const LOW_STOCK_THRESHOLD = Number(process.env.LOW_STOCK_THRESHOLD ?? 5);

@Injectable()
export class InventoryQueryService {
  constructor(private prisma: PrismaService) {}

  async listInventory(query: ListInventoryQueryDto, user: AuthUser) {
    if (query.warehouse_id) {
      return this.listByWarehouse(query, user);
    }
    return this.listExistingLevels(query, user);
  }

  private async listExistingLevels(
    query: ListInventoryQueryDto,
    user: AuthUser,
  ) {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const where = this.buildLevelWhere(query, user);

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
  private async listByWarehouse(
    query: ListInventoryQueryDto,
    user: AuthUser,
  ) {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const warehouseId = BigInt(query.warehouse_id!);

    const warehouse = await this.prisma.warehouse.findUniqueOrThrow({
      where: { id: warehouseId },
    });

    const variantWhere = this.buildVariantWhere(query, warehouseId);

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
        sku: v.sku,
        product_name: v.product.name,
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

  private buildVariantWhere(
    query: ListInventoryQueryDto,
    warehouseId: bigint,
  ): Prisma.ProductVariantWhereInput {
    const where: Prisma.ProductVariantWhereInput = {};

    if (query.variant_id) {
      where.id = BigInt(query.variant_id);
    }

    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [
        { sku: { contains: q, mode: 'insensitive' } },
        { product: { name: { contains: q, mode: 'insensitive' } } },
      ];
    }

    if (query.low_stock) {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        {
          OR: [
            { inventoryLevels: { none: { warehouseId } } },
            {
              inventoryLevels: {
                some: { warehouseId, available: { lte: LOW_STOCK_THRESHOLD } },
              },
            },
          ],
        },
      ];
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

  private buildLevelWhere(
    query: ListInventoryQueryDto,
    user: AuthUser,
  ): Prisma.InventoryLevelWhereInput {
    const where: Prisma.InventoryLevelWhereInput = {};

    where.warehouseId = { in: user.warehouseIds };

    if (query.variant_id) {
      where.variantId = BigInt(query.variant_id);
    }

    if (query.low_stock) {
      where.available = { lte: LOW_STOCK_THRESHOLD };
    }

    if (query.q?.trim()) {
      const q = query.q.trim();
      where.variant = {
        OR: [
          { sku: { contains: q, mode: 'insensitive' } },
          { product: { name: { contains: q, mode: 'insensitive' } } },
        ],
      };
    }

    return where;
  }

  async listLots(variantId: bigint) {
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
