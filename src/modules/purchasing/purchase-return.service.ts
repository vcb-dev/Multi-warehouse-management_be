import { Injectable, NotFoundException } from '@nestjs/common';
import {
  GoodsReceiptStatus,
  InventoryBucket,
  MovementType,
  Prisma,
  RefundStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessException } from '../../common/exceptions/business.exception';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import {
  assertLocationPermission,
  locationScopeFilter,
} from '../../common/auth/access';
import { InventoryService } from '../inventory/inventory.service';
import { sortForLocking } from '../inventory/inventory.types';
import { VoucherService } from '../vouchers/voucher.service';
import {
  CreatePurchaseReturnDto,
  ListPurchaseReturnsQueryDto,
} from './purchasing.dto';
import { serializePurchaseReturn } from './purchasing.serializer';

const pvnInclude = {
  items: {
    include: {
      variant: { select: { sku: true } },
    },
  },
  supplier: { select: { code: true, name: true } },
  location: { select: { code: true, name: true } },
  goodsReceipt: { select: { code: true } },
  createdBy: { select: { firstName: true, lastName: true, email: true } },
} satisfies Prisma.PurchaseReturnInclude;

/** Khớp @RequirePermission trong purchasing.controller. */
const PVN_READ = ['purchasing:manage', 'inventory:view'];
const PVN_WRITE = ['purchasing:manage', 'inventory:receive'];
/** Xác nhận hoàn tiền chặt hơn: chỉ purchasing:manage (khớp controller). */
const PVN_REFUND = ['purchasing:manage'];

@Injectable()
export class PurchaseReturnService {
  constructor(
    private prisma: PrismaService,
    private inventory: InventoryService,
    private vouchers: VoucherService,
  ) {}

  async list(query: ListPurchaseReturnsQueryDto, user: AuthUser) {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const where: Prisma.PurchaseReturnWhereInput = {
      locationId: locationScopeFilter(user, PVN_READ),
    };

    if (query.supplier_id) {
      where.supplierId = BigInt(query.supplier_id);
    }
    if (query.date_from || query.date_to) {
      where.createdAt = {
        ...(query.date_from ? { gte: new Date(query.date_from) } : {}),
        ...(query.date_to ? { lte: new Date(query.date_to) } : {}),
      };
    }

    const [rows, total] = await Promise.all([
      this.prisma.purchaseReturn.findMany({
        where,
        include: pvnInclude,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.purchaseReturn.count({ where }),
    ]);

    return {
      data: rows.map(serializePurchaseReturn),
      total,
      page,
      page_size: pageSize,
    };
  }

  async create(dto: CreatePurchaseReturnDto, user: AuthUser) {
    if (!dto.items?.length) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'PVN phải có ít nhất một dòng',
        422,
      );
    }

    const locationId = BigInt(dto.location_id);
    const supplierId = BigInt(dto.supplier_id);

    await this.validateSupplier(supplierId);
    assertLocationPermission(user, PVN_WRITE, locationId);

    const goodsReceiptId = dto.goods_receipt_id
      ? await this.validateGoodsReceiptRef(
          BigInt(dto.goods_receipt_id),
          supplierId,
          locationId,
        )
      : null;

    await this.validateReturnQuantities(dto.items, locationId);

    const totalQuantity = dto.items.reduce((s, i) => s + i.quantity, 0);
    const totalAmount = dto.items.reduce(
      (s, i) => s + i.quantity * i.unit_price,
      0,
    );
    const code = await this.generateCode();

    const pvn = await this.prisma.$transaction(async (tx) => {
      const record = await tx.purchaseReturn.create({
        data: {
          code,
          supplierId,
          locationId,
          goodsReceiptId,
          totalQuantity,
          totalAmount,
          createdById: user.userId,
          items: {
            create: dto.items.map((item) => ({
              variantId: BigInt(item.variant_id),
              quantity: item.quantity,
              unitPrice: item.unit_price,
            })),
          },
        },
        include: { items: true },
      });

      for (const item of sortForLocking(record.items)) {
        await this.inventory.applyMovement(
          {
            variantId: item.variantId,
            locationId,
            bucket: InventoryBucket.on_hand,
            change: -item.quantity,
            type: MovementType.return_out,
            referenceType: 'purchase_return',
            referenceId: record.id,
            createdById: user.userId,
          },
          tx,
        );
      }

      await tx.supplierLedgerEntry.create({
        data: {
          supplierId,
          referenceType: 'purchase_return',
          referenceCode: code,
          transactionLabel: 'Trả hàng nhập',
          reason: 'Tạo đơn trả hàng nhập',
          amount: totalAmount,
          createdById: user.userId,
        },
      });

      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'purchase_return.create',
          entityType: 'purchase_return',
          entityId: record.id,
          metadata: { code: record.code },
        },
      });

      return tx.purchaseReturn.findUniqueOrThrow({
        where: { id: record.id },
        include: pvnInclude,
      });
    });

    return { data: serializePurchaseReturn(pvn) };
  }

  async findOne(id: bigint, user: AuthUser) {
    const pvn = await this.prisma.purchaseReturn.findUnique({
      where: { id },
      include: pvnInclude,
    });
    if (!pvn) throw new NotFoundException('Không tìm thấy phiếu trả hàng');
    assertLocationPermission(user, PVN_READ, pvn.locationId);
    return { data: serializePurchaseReturn(pvn) };
  }

  /** Chốt quyền theo kho của phiếu cho endpoint không cần nạp cả phiếu. */
  async assertReturnReadable(id: bigint, user: AuthUser) {
    const pvn = await this.prisma.purchaseReturn.findUnique({
      where: { id },
      select: { locationId: true },
    });
    if (!pvn) throw new NotFoundException('Không tìm thấy phiếu trả hàng');
    assertLocationPermission(user, PVN_READ, pvn.locationId);
  }

  async confirmRefund(id: bigint, user: AuthUser) {
    const pvn = await this.prisma.purchaseReturn.findUnique({
      where: { id },
      include: { supplier: true, location: true },
    });
    if (!pvn) throw new NotFoundException('Không tìm thấy phiếu trả hàng');
    if (pvn.refundStatus === RefundStatus.refunded) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Phiếu trả đã nhận hoàn tiền',
        409,
      );
    }

    assertLocationPermission(user, PVN_REFUND, pvn.locationId);

    const voucher = await this.prisma.$transaction(async (tx) => {
      await tx.purchaseReturn.update({
        where: { id },
        data: {
          refundStatus: RefundStatus.refunded,
          refundedAt: new Date(),
        },
      });

      // NCC hoàn tiền mặt thay vì trừ công nợ → đảo lại bút toán giảm nợ khi tạo phiếu trả
      await tx.supplierLedgerEntry.create({
        data: {
          supplierId: pvn.supplierId,
          referenceType: 'refund',
          referenceCode: pvn.code,
          transactionLabel: 'Nhận hoàn tiền',
          reason: 'NCC hoàn tiền trả hàng nhập',
          amount: -Number(pvn.totalAmount),
          createdById: user.userId,
        },
      });

      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'purchase_return.confirm_refund',
          entityType: 'purchase_return',
          entityId: pvn.id,
          metadata: { code: pvn.code },
        },
      });

      return this.vouchers.createReceipt(
        {
          locationId: pvn.locationId,
          amount: Number(pvn.totalAmount),
          createdById: user.userId,
          sourceDocument: pvn.code,
          referenceType: 'purchase_return',
          referenceId: pvn.id,
          reason: `Nhận hoàn tiền trả hàng nhập — NCC ${pvn.supplier.name}`,
        },
        tx,
      );
    });

    return {
      id: pvn.id.toString(),
      refund_status: RefundStatus.refunded,
      voucher,
    };
  }

  /** "Trả theo đơn" — đơn nhập gốc phải đã nhập kho và khớp đúng NCC/kho đang trả */
  private async validateGoodsReceiptRef(
    goodsReceiptId: bigint,
    supplierId: bigint,
    locationId: bigint,
  ) {
    const rei = await this.prisma.goodsReceipt.findUnique({
      where: { id: goodsReceiptId },
    });
    if (!rei) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Đơn nhập hàng không tồn tại',
        422,
      );
    }
    if (rei.status !== GoodsReceiptStatus.received) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Chỉ trả hàng theo đơn nhập đã nhập kho',
        422,
      );
    }
    if (rei.supplierId !== supplierId) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'NCC không khớp với đơn nhập hàng',
        422,
      );
    }
    if (rei.locationId !== locationId) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Kho không khớp với đơn nhập hàng',
        422,
      );
    }
    return goodsReceiptId;
  }

  /** Không còn theo dõi theo lô — chỉ đảm bảo không trả vượt tồn hiện có tại kho */
  private async validateReturnQuantities(
    items: CreatePurchaseReturnDto['items'],
    locationId: bigint,
  ) {
    const qtyByVariant = new Map<string, number>();
    for (const item of items) {
      const key = item.variant_id;
      qtyByVariant.set(key, (qtyByVariant.get(key) ?? 0) + item.quantity);
    }

    for (const [variantId, qty] of qtyByVariant) {
      const level = await this.prisma.inventoryLevel.findUnique({
        where: {
          variantId_locationId: {
            variantId: BigInt(variantId),
            locationId,
          },
        },
      });
      const available = level?.available ?? 0;
      if (qty > available) {
        throw new BusinessException(
          'RETURN_EXCEEDS_RECEIPT',
          `Trả vượt tồn khả dụng tại kho (còn ${available}, yêu cầu ${qty})`,
          409,
        );
      }
    }
  }

  private async validateSupplier(id: bigint) {
    const s = await this.prisma.supplier.findUnique({ where: { id } });
    if (!s || !s.isActive) {
      throw new BusinessException('VALIDATION_ERROR', 'NCC không hợp lệ', 422);
    }
  }

  private async generateCode() {
    const count = await this.prisma.purchaseReturn.count();
    return `PVN${String(count + 1).padStart(6, '0')}`;
  }
}
