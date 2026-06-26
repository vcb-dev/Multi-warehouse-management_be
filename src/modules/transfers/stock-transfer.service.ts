import { Injectable, NotFoundException } from '@nestjs/common';
import {
  InventoryBucket,
  MovementType,
  Prisma,
  StockTransferStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessException } from '../../common/exceptions/business.exception';
import { InsufficientStockException } from '../../common/exceptions/business.exception';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { InventoryService } from '../inventory/inventory.service';
import {
  CreateStockTransferDto,
  ListStockTransfersQueryDto,
} from './stock-transfer.dto';
import { serializeStockTransfer } from './stock-transfer.serializer';

const stnInclude = {
  items: {
    include: {
      variant: { select: { sku: true } },
      lot: { select: { code: true } },
    },
  },
  fromWarehouse: { select: { code: true, name: true } },
  toWarehouse: { select: { code: true, name: true } },
} satisfies Prisma.StockTransferInclude;

@Injectable()
export class StockTransferService {
  constructor(
    private prisma: PrismaService,
    private inventory: InventoryService,
  ) {}

  async list(query: ListStockTransfersQueryDto, user: AuthUser) {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const where: Prisma.StockTransferWhereInput = {};

    if (query.status) {
      where.status = query.status as StockTransferStatus;
    }

    where.OR = [
      { fromWarehouseId: { in: user.warehouseIds } },
      { toWarehouseId: { in: user.warehouseIds } },
    ];

    const [rows, total] = await Promise.all([
      this.prisma.stockTransfer.findMany({
        where,
        include: stnInclude,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.stockTransfer.count({ where }),
    ]);

    return {
      data: rows.map(serializeStockTransfer),
      total,
      page,
      page_size: pageSize,
    };
  }

  async findOne(id: bigint) {
    const stn = await this.prisma.stockTransfer.findUnique({
      where: { id },
      include: stnInclude,
    });
    if (!stn) throw new NotFoundException('Không tìm thấy phiếu chuyển');
    return { data: serializeStockTransfer(stn) };
  }

  async create(dto: CreateStockTransferDto, user: AuthUser) {
    if (!dto.items?.length) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Phiếu chuyển phải có ít nhất một dòng',
        422,
      );
    }

    const fromId = BigInt(dto.from_warehouse_id);
    const toId = BigInt(dto.to_warehouse_id);

    if (fromId === toId) {
      throw new BusinessException(
        'SAME_WAREHOUSE',
        'Kho đi và kho nhận phải khác nhau',
        422,
      );
    }

    this.inventory.assertWarehouseAccess(user, fromId);

    await this.validateWarehouses(fromId, toId);
    await this.validateItems(dto.items, fromId);

    const totalQuantity = dto.items.reduce((s, i) => s + i.quantity, 0);
    const code = await this.generateCode();

    const stn = await this.prisma.$transaction(async (tx) => {
      const transfer = await tx.stockTransfer.create({
        data: {
          code,
          fromWarehouseId: fromId,
          toWarehouseId: toId,
          status: StockTransferStatus.dang_chuyen,
          note: dto.note?.trim() || null,
          totalQuantity,
          createdById: user.userId,
          items: {
            create: dto.items.map((item) => ({
              variantId: BigInt(item.variant_id),
              lotId: BigInt(item.lot_id),
              quantity: item.quantity,
            })),
          },
        },
        include: { items: true },
      });

      for (const item of transfer.items) {
        await this.inventory.applyMovement(
          {
            variantId: item.variantId,
            warehouseId: fromId,
            bucket: InventoryBucket.on_hand,
            change: -item.quantity,
            type: MovementType.transfer_out,
            referenceType: 'stock_transfer',
            referenceId: transfer.id,
            lotId: item.lotId,
            createdById: user.userId,
          },
          tx,
        );
      }

      return tx.stockTransfer.findUniqueOrThrow({
        where: { id: transfer.id },
        include: stnInclude,
      });
    });

    return { data: serializeStockTransfer(stn) };
  }

  async receive(id: bigint, user: AuthUser) {
    const stn = await this.prisma.stockTransfer.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!stn) throw new NotFoundException('Không tìm thấy phiếu chuyển');

    if (stn.status !== StockTransferStatus.dang_chuyen) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Chỉ nhận phiếu đang chuyển',
        409,
      );
    }

    this.inventory.assertWarehouseAccess(user, stn.toWarehouseId);

    await this.prisma.$transaction(async (tx) => {
      for (const item of stn.items) {
        await this.inventory.applyMovement(
          {
            variantId: item.variantId,
            warehouseId: stn.toWarehouseId,
            bucket: InventoryBucket.on_hand,
            change: item.quantity,
            type: MovementType.transfer_in,
            referenceType: 'stock_transfer',
            referenceId: stn.id,
            lotId: item.lotId,
            createdById: user.userId,
          },
          tx,
        );
      }

      await tx.stockTransfer.update({
        where: { id },
        data: {
          status: StockTransferStatus.da_nhan,
          receivedAt: new Date(),
          receivedById: user.userId,
        },
      });
    });

    return this.findOne(id);
  }

  async cancel(id: bigint, user: AuthUser) {
    const stn = await this.prisma.stockTransfer.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!stn) throw new NotFoundException('Không tìm thấy phiếu chuyển');

    if (stn.status === StockTransferStatus.da_nhan) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Không thể hủy phiếu đã nhận',
        409,
      );
    }
    if (stn.status === StockTransferStatus.huy) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Phiếu đã hủy',
        409,
      );
    }

    this.inventory.assertWarehouseAccess(user, stn.fromWarehouseId);

    await this.prisma.$transaction(async (tx) => {
      for (const item of stn.items) {
        await this.inventory.applyMovement(
          {
            variantId: item.variantId,
            warehouseId: stn.fromWarehouseId,
            bucket: InventoryBucket.on_hand,
            change: item.quantity,
            type: MovementType.transfer_in,
            referenceType: 'stock_transfer',
            referenceId: stn.id,
            lotId: item.lotId,
            createdById: user.userId,
          },
          tx,
        );
      }

      await tx.stockTransfer.update({
        where: { id },
        data: { status: StockTransferStatus.huy },
      });
    });

    return this.findOne(id);
  }

  private async validateWarehouses(fromId: bigint, toId: bigint) {
    const [from, to] = await Promise.all([
      this.prisma.warehouse.findUnique({ where: { id: fromId } }),
      this.prisma.warehouse.findUnique({ where: { id: toId } }),
    ]);
    if (!from?.isActive || !to?.isActive) {
      throw new BusinessException('VALIDATION_ERROR', 'Kho không hợp lệ', 422);
    }
  }

  private async validateItems(
    items: CreateStockTransferDto['items'],
    fromWarehouseId: bigint,
  ) {
    const qtyByVariant = new Map<string, number>();
    for (const item of items) {
      const lot = await this.prisma.lot.findUnique({
        where: { id: BigInt(item.lot_id) },
      });
      if (!lot || lot.variantId !== BigInt(item.variant_id)) {
        throw new BusinessException(
          'VALIDATION_ERROR',
          'Lô không khớp với phiên bản',
          422,
        );
      }

      const key = item.variant_id;
      qtyByVariant.set(key, (qtyByVariant.get(key) ?? 0) + item.quantity);
    }

    for (const [variantId, qty] of qtyByVariant) {
      const level = await this.prisma.inventoryLevel.findUnique({
        where: {
          variantId_warehouseId: {
            variantId: BigInt(variantId),
            warehouseId: fromWarehouseId,
          },
        },
      });
      const available = level?.available ?? 0;
      if (qty > available) {
        throw new InsufficientStockException(
          `Không đủ available tại kho đi (cần ${qty}, có ${available})`,
        );
      }
    }
  }

  private async generateCode() {
    const count = await this.prisma.stockTransfer.count();
    return `STN${String(count + 1).padStart(6, '0')}`;
  }
}
