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
import { sortForLocking } from '../inventory/inventory.types';
import {
  CreateStockTransferDto,
  ListStockTransfersQueryDto,
  UpdateStockTransferDto,
} from './stock-transfer.dto';
import { serializeStockTransfer } from './stock-transfer.serializer';

const stnInclude = {
  items: {
    include: {
      variant: {
        select: { sku: true, cost: true, product: { select: { name: true } } },
      },
      lot: { select: { code: true } },
    },
  },
  fromWarehouse: { select: { code: true, name: true } },
  toWarehouse: { select: { code: true, name: true } },
  createdBy: { select: { name: true, email: true } },
} satisfies Prisma.StockTransferInclude;

type StnWithItems = Prisma.StockTransferGetPayload<{
  include: { items: true };
}>;

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
    // Phiếu nháp chưa cam kết gì nên chỉ kiểm tra lô khớp phiên bản — tồn kho
    // khả dụng được kiểm tra ở bước "submit" (giữ chỗ), giống các nháp khác
    // trong hệ thống không nên ràng buộc tồn kho ngay từ lúc tạo.
    await this.validateLotMatch(dto.items);

    const totalQuantity = dto.items.reduce((s, i) => s + i.quantity, 0);
    const code = await this.resolveCode(dto.code);

    const stn = await this.prisma.$transaction(async (tx) => {
      const transfer = await tx.stockTransfer.create({
        data: {
          code,
          fromWarehouseId: fromId,
          toWarehouseId: toId,
          status: StockTransferStatus.nhap,
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

      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'stock_transfer.create',
          entityType: 'stock_transfer',
          entityId: transfer.id,
          metadata: { code: transfer.code },
        },
      });

      return tx.stockTransfer.findUniqueOrThrow({
        where: { id: transfer.id },
        include: stnInclude,
      });
    });

    return { data: serializeStockTransfer(stn) };
  }

  async update(id: bigint, dto: UpdateStockTransferDto, user: AuthUser) {
    const stn = await this.prisma.stockTransfer.findUnique({ where: { id } });
    if (!stn) throw new NotFoundException('Không tìm thấy phiếu chuyển');
    if (stn.status !== StockTransferStatus.nhap) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Chỉ sửa được phiếu ở trạng thái nháp',
        409,
      );
    }
    if (dto.items && !dto.items.length) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Phiếu chuyển phải có ít nhất một dòng',
        422,
      );
    }

    this.inventory.assertWarehouseAccess(user, stn.fromWarehouseId);

    const fromId = dto.from_warehouse_id
      ? BigInt(dto.from_warehouse_id)
      : stn.fromWarehouseId;
    const toId = dto.to_warehouse_id
      ? BigInt(dto.to_warehouse_id)
      : stn.toWarehouseId;

    if (fromId === toId) {
      throw new BusinessException(
        'SAME_WAREHOUSE',
        'Kho đi và kho nhận phải khác nhau',
        422,
      );
    }
    if (dto.from_warehouse_id) {
      this.inventory.assertWarehouseAccess(user, fromId);
    }
    await this.validateWarehouses(fromId, toId);
    if (dto.items) {
      await this.validateLotMatch(dto.items);
    }

    const data: Prisma.StockTransferUpdateInput = {};
    if (dto.from_warehouse_id) {
      data.fromWarehouse = { connect: { id: fromId } };
    }
    if (dto.to_warehouse_id) {
      data.toWarehouse = { connect: { id: toId } };
    }
    if (dto.note !== undefined) {
      data.note = dto.note.trim() || null;
    }
    if (dto.items) {
      data.totalQuantity = dto.items.reduce((s, i) => s + i.quantity, 0);
      data.items = {
        deleteMany: {},
        create: dto.items.map((item) => ({
          variantId: BigInt(item.variant_id),
          lotId: BigInt(item.lot_id),
          quantity: item.quantity,
        })),
      };
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.stockTransfer.update({
        where: { id },
        data,
        include: stnInclude,
      });

      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'stock_transfer.update',
          entityType: 'stock_transfer',
          entityId: id,
          metadata: { code: result.code },
        },
      });

      return result;
    });

    return { data: serializeStockTransfer(updated) };
  }

  async transition(id: bigint, action: 'submit' | 'ship', user: AuthUser) {
    const stn = await this.prisma.stockTransfer.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!stn) throw new NotFoundException('Không tìm thấy phiếu chuyển');

    this.inventory.assertWarehouseAccess(user, stn.fromWarehouseId);

    switch (action) {
      case 'submit':
        return this.submit(stn, user);
      case 'ship':
        return this.ship(stn, user);
      default:
        throw new BusinessException(
          'INVALID_TRANSITION',
          'Action không hợp lệ',
          409,
        );
    }
  }

  /** Phiếu nháp → Chờ chuyển: giữ chỗ tồn kho (committed) ở kho chuyển */
  private async submit(stn: StnWithItems, user: AuthUser) {
    if (stn.status !== StockTransferStatus.nhap) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Chỉ submit phiếu ở trạng thái nháp',
        409,
      );
    }

    await this.validateAvailability(stn.items, stn.fromWarehouseId);

    await this.prisma.$transaction(async (tx) => {
      for (const item of sortForLocking(stn.items)) {
        await this.inventory.applyMovement(
          {
            variantId: item.variantId,
            warehouseId: stn.fromWarehouseId,
            bucket: InventoryBucket.committed,
            change: item.quantity,
            type: MovementType.transfer_reserve,
            referenceType: 'stock_transfer',
            referenceId: stn.id,
            lotId: item.lotId,
            createdById: user.userId,
          },
          tx,
        );
      }

      await tx.stockTransfer.update({
        where: { id: stn.id },
        data: { status: StockTransferStatus.cho_chuyen },
      });

      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'stock_transfer.submit',
          entityType: 'stock_transfer',
          entityId: stn.id,
          metadata: { code: stn.code },
        },
      });
    });

    return this.findOne(stn.id);
  }

  /** Chờ chuyển → Đang chuyển: xuất kho thật, giải phóng chỗ giữ */
  private async ship(stn: StnWithItems, user: AuthUser) {
    if (stn.status !== StockTransferStatus.cho_chuyen) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Chỉ xuất kho phiếu đang chờ chuyển',
        409,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      for (const item of sortForLocking(stn.items)) {
        await this.inventory.applyMovements(
          [
            {
              variantId: item.variantId,
              warehouseId: stn.fromWarehouseId,
              bucket: InventoryBucket.committed,
              change: -item.quantity,
              type: MovementType.transfer_release,
              referenceType: 'stock_transfer',
              referenceId: stn.id,
              lotId: item.lotId,
              createdById: user.userId,
            },
            {
              variantId: item.variantId,
              warehouseId: stn.fromWarehouseId,
              bucket: InventoryBucket.on_hand,
              change: -item.quantity,
              type: MovementType.transfer_out,
              referenceType: 'stock_transfer',
              referenceId: stn.id,
              lotId: item.lotId,
              createdById: user.userId,
            },
          ],
          tx,
        );

        // Kho nhận thấy "hàng đang về" trong lúc phiếu trên đường
        await this.inventory.applyMovement(
          {
            variantId: item.variantId,
            warehouseId: stn.toWarehouseId,
            bucket: InventoryBucket.incoming,
            change: item.quantity,
            type: MovementType.incoming_transfer,
            referenceType: 'stock_transfer',
            referenceId: stn.id,
            lotId: item.lotId,
            createdById: user.userId,
          },
          tx,
        );
      }

      await tx.stockTransfer.update({
        where: { id: stn.id },
        data: {
          status: StockTransferStatus.dang_chuyen,
          shippedAt: new Date(),
        },
      });

      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'stock_transfer.ship',
          entityType: 'stock_transfer',
          entityId: stn.id,
          metadata: { code: stn.code },
        },
      });
    });

    return this.findOne(stn.id);
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
      for (const item of sortForLocking(stn.items)) {
        await this.inventory.applyMovements(
          [
            {
              variantId: item.variantId,
              warehouseId: stn.toWarehouseId,
              bucket: InventoryBucket.incoming,
              change: -item.quantity,
              type: MovementType.incoming_receipt,
              referenceType: 'stock_transfer',
              referenceId: stn.id,
              lotId: item.lotId,
              createdById: user.userId,
            },
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
          ],
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

      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'stock_transfer.receive',
          entityType: 'stock_transfer',
          entityId: stn.id,
          metadata: { code: stn.code },
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
      throw new BusinessException('INVALID_TRANSITION', 'Phiếu đã hủy', 409);
    }

    this.inventory.assertWarehouseAccess(user, stn.fromWarehouseId);

    // Phiếu nháp chưa từng đụng tồn kho — hủy = xóa hẳn, giống quy ước hủy
    // PO/REI ở trạng thái nháp (không giữ lại bản ghi "đã hủy" vô nghĩa).
    if (stn.status === StockTransferStatus.nhap) {
      await this.prisma.$transaction(async (tx) => {
        await tx.activityLog.create({
          data: {
            userId: user.userId,
            action: 'stock_transfer.cancel',
            entityType: 'stock_transfer',
            entityId: stn.id,
            metadata: { code: stn.code },
          },
        });
        await tx.stockTransfer.delete({ where: { id } });
      });
      return { id: stn.id.toString(), deleted: true };
    }

    await this.prisma.$transaction(async (tx) => {
      if (stn.status === StockTransferStatus.cho_chuyen) {
        // Đang giữ chỗ (committed) — hủy chỉ cần giải phóng chỗ giữ, hàng
        // chưa từng rời kho chuyển nên không có gì để hoàn ở on_hand/incoming.
        for (const item of sortForLocking(stn.items)) {
          await this.inventory.applyMovement(
            {
              variantId: item.variantId,
              warehouseId: stn.fromWarehouseId,
              bucket: InventoryBucket.committed,
              change: -item.quantity,
              type: MovementType.transfer_release,
              referenceType: 'stock_transfer',
              referenceId: stn.id,
              lotId: item.lotId,
              createdById: user.userId,
            },
            tx,
          );
        }
      } else {
        // dang_chuyen: hàng đã thật sự rời kho chuyển — hoàn on_hand kho
        // chuyển, gỡ "hàng đang về" tại kho nhận.
        for (const item of sortForLocking(stn.items)) {
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

          await this.inventory.applyMovement(
            {
              variantId: item.variantId,
              warehouseId: stn.toWarehouseId,
              bucket: InventoryBucket.incoming,
              change: -item.quantity,
              type: MovementType.incoming_cancel,
              referenceType: 'stock_transfer',
              referenceId: stn.id,
              lotId: item.lotId,
              createdById: user.userId,
            },
            tx,
          );
        }
      }

      await tx.stockTransfer.update({
        where: { id },
        data: { status: StockTransferStatus.huy },
      });

      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'stock_transfer.cancel',
          entityType: 'stock_transfer',
          entityId: stn.id,
          metadata: { code: stn.code },
        },
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

  private async validateLotMatch(items: CreateStockTransferDto['items']) {
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
    }
  }

  /** Chạy ở bước submit (giữ chỗ tồn kho), không phải lúc tạo phiếu nháp */
  private async validateAvailability(
    items: { variantId: bigint; quantity: number }[],
    fromWarehouseId: bigint,
  ) {
    const qtyByVariant = new Map<string, number>();
    for (const item of items) {
      const key = item.variantId.toString();
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
          `Không đủ available tại kho chuyển (cần ${qty}, có ${available})`,
        );
      }
    }
  }

  private async resolveCode(customCode?: string) {
    const trimmed = customCode?.trim();
    if (!trimmed) return this.generateCode();

    const existing = await this.prisma.stockTransfer.findUnique({
      where: { code: trimmed },
    });
    if (existing) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        `Mã phiếu chuyển "${trimmed}" đã tồn tại`,
        422,
      );
    }
    return trimmed;
  }

  private async generateCode() {
    const count = await this.prisma.stockTransfer.count();
    return `STN${String(count + 1).padStart(6, '0')}`;
  }
}
