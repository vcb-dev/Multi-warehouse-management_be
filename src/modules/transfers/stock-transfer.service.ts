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
import {
  assertLocationPermission,
  hasLocationPermission,
  locationScopeFilter,
} from '../../common/auth/access';
import { InventoryService } from '../inventory/inventory.service';
import { sortForLocking } from '../inventory/inventory.types';
import {
  CreateStockTransferDto,
  ListStockTransfersQueryDto,
  UpdateStockTransferDto,
} from './stock-transfer.dto';
import { serializeStockTransfer } from './stock-transfer.serializer';

/** Khớp @RequirePermission của các endpoint đọc trong stock-transfer.controller. */
const READ_PERMISSIONS = ['inventory:transfer', 'inventory:view'];

const stnInclude = {
  items: {
    include: {
      variant: {
        select: { sku: true, cost: true, product: { select: { name: true } } },
      },
    },
  },
  fromLocation: { select: { code: true, name: true } },
  toLocation: { select: { code: true, name: true } },
  createdBy: { select: { firstName: true, lastName: true, email: true } },
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

    // Phiếu chuyển liên quan hai kho — thấy được nếu có quyền ở kho đi HOẶC kho đến.
    const readable = locationScopeFilter(user, READ_PERMISSIONS);
    if (readable) {
      where.OR = [{ fromLocationId: readable }, { toLocationId: readable }];
    }

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

  async findOne(id: bigint, user: AuthUser) {
    const stn = await this.prisma.stockTransfer.findUnique({
      where: { id },
      include: stnInclude,
    });
    if (!stn) throw new NotFoundException('Không tìm thấy phiếu chuyển');
    this.assertReadable(user, stn);
    return { data: serializeStockTransfer(stn) };
  }

  /** Đọc được phiếu nếu có quyền ở kho đi HOẶC kho đến. */
  private assertReadable(
    user: AuthUser,
    stn: { fromLocationId: bigint; toLocationId: bigint },
  ) {
    const readable = READ_PERMISSIONS.some(
      (perm) =>
        hasLocationPermission(user, perm, stn.fromLocationId.toString()) ||
        hasLocationPermission(user, perm, stn.toLocationId.toString()),
    );
    if (!readable) {
      throw new BusinessException(
        'FORBIDDEN_SCOPE',
        'Bạn không có quyền xem phiếu chuyển của kho này.',
        403,
      );
    }
  }

  /** Chốt quyền theo kho của phiếu cho endpoint không cần nạp cả phiếu. */
  async assertTransferReadable(id: bigint, user: AuthUser) {
    const stn = await this.prisma.stockTransfer.findUnique({
      where: { id },
      select: { fromLocationId: true, toLocationId: true },
    });
    if (!stn) throw new NotFoundException('Không tìm thấy phiếu chuyển');
    this.assertReadable(user, stn);
  }

  async create(dto: CreateStockTransferDto, user: AuthUser) {
    if (!dto.items?.length) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Phiếu chuyển phải có ít nhất một dòng',
        422,
      );
    }

    const fromId = BigInt(dto.from_location_id);
    const toId = BigInt(dto.to_location_id);

    if (fromId === toId) {
      throw new BusinessException(
        'SAME_WAREHOUSE',
        'Kho đi và kho nhận phải khác nhau',
        422,
      );
    }

    assertLocationPermission(user, 'inventory:transfer', fromId);

    await this.validateWarehouses(fromId, toId);

    const totalQuantity = dto.items.reduce((s, i) => s + i.quantity, 0);
    const code = await this.resolveCode(dto.code);

    const stn = await this.prisma.$transaction(async (tx) => {
      const transfer = await tx.stockTransfer.create({
        data: {
          code,
          fromLocationId: fromId,
          toLocationId: toId,
          status: StockTransferStatus.draft,
          note: dto.note?.trim() || null,
          totalQuantity,
          createdById: user.userId,
          items: {
            create: dto.items.map((item) => ({
              variantId: BigInt(item.variant_id),
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
    if (stn.status !== StockTransferStatus.draft) {
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

    assertLocationPermission(user, 'inventory:transfer', stn.fromLocationId);

    const fromId = dto.from_location_id
      ? BigInt(dto.from_location_id)
      : stn.fromLocationId;
    const toId = dto.to_location_id
      ? BigInt(dto.to_location_id)
      : stn.toLocationId;

    if (fromId === toId) {
      throw new BusinessException(
        'SAME_WAREHOUSE',
        'Kho đi và kho nhận phải khác nhau',
        422,
      );
    }
    if (dto.from_location_id) {
      assertLocationPermission(user, 'inventory:transfer', fromId);
    }
    await this.validateWarehouses(fromId, toId);

    const data: Prisma.StockTransferUpdateInput = {};
    if (dto.from_location_id) {
      data.fromLocation = { connect: { id: fromId } };
    }
    if (dto.to_location_id) {
      data.toLocation = { connect: { id: toId } };
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

    assertLocationPermission(user, 'inventory:transfer', stn.fromLocationId);

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
    if (stn.status !== StockTransferStatus.draft) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Chỉ submit phiếu ở trạng thái nháp',
        409,
      );
    }

    await this.validateAvailability(stn.items, stn.fromLocationId);

    await this.prisma.$transaction(async (tx) => {
      for (const item of sortForLocking(stn.items)) {
        await this.inventory.applyMovement(
          {
            variantId: item.variantId,
            locationId: stn.fromLocationId,
            bucket: InventoryBucket.committed,
            change: item.quantity,
            type: MovementType.transfer_reserve,
            referenceType: 'stock_transfer',
            referenceId: stn.id,
            createdById: user.userId,
          },
          tx,
        );
      }

      await tx.stockTransfer.update({
        where: { id: stn.id },
        data: { status: StockTransferStatus.pending },
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

    return this.findOne(stn.id, user);
  }

  /** Chờ chuyển → Đang chuyển: xuất kho thật, giải phóng chỗ giữ */
  private async ship(stn: StnWithItems, user: AuthUser) {
    if (stn.status !== StockTransferStatus.pending) {
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
              locationId: stn.fromLocationId,
              bucket: InventoryBucket.committed,
              change: -item.quantity,
              type: MovementType.transfer_release,
              referenceType: 'stock_transfer',
              referenceId: stn.id,
              createdById: user.userId,
            },
            {
              variantId: item.variantId,
              locationId: stn.fromLocationId,
              bucket: InventoryBucket.on_hand,
              change: -item.quantity,
              type: MovementType.transfer_out,
              referenceType: 'stock_transfer',
              referenceId: stn.id,
              createdById: user.userId,
            },
          ],
          tx,
        );

        // Kho nhận thấy "hàng đang về" trong lúc phiếu trên đường
        await this.inventory.applyMovement(
          {
            variantId: item.variantId,
            locationId: stn.toLocationId,
            bucket: InventoryBucket.incoming,
            change: item.quantity,
            type: MovementType.incoming_transfer,
            referenceType: 'stock_transfer',
            referenceId: stn.id,
            createdById: user.userId,
          },
          tx,
        );
      }

      await tx.stockTransfer.update({
        where: { id: stn.id },
        data: {
          status: StockTransferStatus.transferring,
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

    return this.findOne(stn.id, user);
  }

  async receive(id: bigint, user: AuthUser) {
    const stn = await this.prisma.stockTransfer.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!stn) throw new NotFoundException('Không tìm thấy phiếu chuyển');

    if (stn.status !== StockTransferStatus.transferring) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Chỉ nhận phiếu đang chuyển',
        409,
      );
    }

    assertLocationPermission(user, 'inventory:transfer', stn.toLocationId);

    await this.prisma.$transaction(async (tx) => {
      for (const item of sortForLocking(stn.items)) {
        await this.inventory.applyMovements(
          [
            {
              variantId: item.variantId,
              locationId: stn.toLocationId,
              bucket: InventoryBucket.incoming,
              change: -item.quantity,
              type: MovementType.incoming_receipt,
              referenceType: 'stock_transfer',
              referenceId: stn.id,
              createdById: user.userId,
            },
            {
              variantId: item.variantId,
              locationId: stn.toLocationId,
              bucket: InventoryBucket.on_hand,
              change: item.quantity,
              type: MovementType.transfer_in,
              referenceType: 'stock_transfer',
              referenceId: stn.id,
              createdById: user.userId,
            },
          ],
          tx,
        );
      }

      await tx.stockTransfer.update({
        where: { id },
        data: {
          status: StockTransferStatus.received,
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

    return this.findOne(id, user);
  }

  async cancel(id: bigint, user: AuthUser) {
    const stn = await this.prisma.stockTransfer.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!stn) throw new NotFoundException('Không tìm thấy phiếu chuyển');

    if (stn.status === StockTransferStatus.received) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Không thể hủy phiếu đã nhận',
        409,
      );
    }
    if (stn.status === StockTransferStatus.cancelled) {
      throw new BusinessException('INVALID_TRANSITION', 'Phiếu đã hủy', 409);
    }

    assertLocationPermission(user, 'inventory:transfer', stn.fromLocationId);

    // Phiếu nháp chưa từng đụng tồn kho — hủy = xóa hẳn, giống quy ước hủy
    // PO/REI ở trạng thái nháp (không giữ lại bản ghi "đã hủy" vô nghĩa).
    if (stn.status === StockTransferStatus.draft) {
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
      if (stn.status === StockTransferStatus.pending) {
        // Đang giữ chỗ (committed) — hủy chỉ cần giải phóng chỗ giữ, hàng
        // chưa từng rời kho chuyển nên không có gì để hoàn ở on_hand/incoming.
        for (const item of sortForLocking(stn.items)) {
          await this.inventory.applyMovement(
            {
              variantId: item.variantId,
              locationId: stn.fromLocationId,
              bucket: InventoryBucket.committed,
              change: -item.quantity,
              type: MovementType.transfer_release,
              referenceType: 'stock_transfer',
              referenceId: stn.id,
              createdById: user.userId,
            },
            tx,
          );
        }
      } else {
        // transferring: hàng đã thật sự rời kho chuyển — hoàn on_hand kho
        // chuyển, gỡ "hàng đang về" tại kho nhận.
        for (const item of sortForLocking(stn.items)) {
          await this.inventory.applyMovement(
            {
              variantId: item.variantId,
              locationId: stn.fromLocationId,
              bucket: InventoryBucket.on_hand,
              change: item.quantity,
              type: MovementType.transfer_in,
              referenceType: 'stock_transfer',
              referenceId: stn.id,
              createdById: user.userId,
            },
            tx,
          );

          await this.inventory.applyMovement(
            {
              variantId: item.variantId,
              locationId: stn.toLocationId,
              bucket: InventoryBucket.incoming,
              change: -item.quantity,
              type: MovementType.incoming_cancel,
              referenceType: 'stock_transfer',
              referenceId: stn.id,
              createdById: user.userId,
            },
            tx,
          );
        }
      }

      await tx.stockTransfer.update({
        where: { id },
        data: { status: StockTransferStatus.cancelled },
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

    return this.findOne(id, user);
  }

  private async validateWarehouses(fromId: bigint, toId: bigint) {
    const [from, to] = await Promise.all([
      this.prisma.location.findUnique({ where: { id: fromId } }),
      this.prisma.location.findUnique({ where: { id: toId } }),
    ]);
    if (from?.status !== 'active' || to?.status !== 'active') {
      throw new BusinessException('VALIDATION_ERROR', 'Kho không hợp lệ', 422);
    }
  }

  /** Chạy ở bước submit (giữ chỗ tồn kho), không phải lúc tạo phiếu nháp */
  private async validateAvailability(
    items: { variantId: bigint; quantity: number }[],
    fromLocationId: bigint,
  ) {
    const qtyByVariant = new Map<string, number>();
    for (const item of items) {
      const key = item.variantId.toString();
      qtyByVariant.set(key, (qtyByVariant.get(key) ?? 0) + item.quantity);
    }

    for (const [variantId, qty] of qtyByVariant) {
      const level = await this.prisma.inventoryLevel.findUnique({
        where: {
          variantId_locationId: {
            variantId: BigInt(variantId),
            locationId: fromLocationId,
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
