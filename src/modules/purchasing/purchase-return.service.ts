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
import { InventoryService } from '../inventory/inventory.service';
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
      lot: { select: { code: true } },
    },
  },
  supplier: { select: { code: true, name: true } },
  warehouse: { select: { code: true, name: true } },
} satisfies Prisma.PurchaseReturnInclude;

@Injectable()
export class PurchaseReturnService {
  constructor(
    private prisma: PrismaService,
    private inventory: InventoryService,
    private vouchers: VoucherService,
  ) {}

  async list(query: ListPurchaseReturnsQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const where: Prisma.PurchaseReturnWhereInput = {};

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

    const warehouseId = BigInt(dto.warehouse_id);
    const supplierId = BigInt(dto.supplier_id);

    await this.validateSupplier(supplierId);
    this.inventory.assertWarehouseAccess(user, warehouseId);

    await this.validateReturnQuantities(dto.items, warehouseId);

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
          warehouseId,
          totalQuantity,
          totalAmount,
          createdById: user.userId,
          items: {
            create: dto.items.map((item) => ({
              variantId: BigInt(item.variant_id),
              lotId: BigInt(item.lot_id),
              quantity: item.quantity,
              unitPrice: item.unit_price,
            })),
          },
        },
        include: { items: true },
      });

      for (const item of record.items) {
        await this.inventory.applyMovement(
          {
            variantId: item.variantId,
            warehouseId,
            bucket: InventoryBucket.on_hand,
            change: -item.quantity,
            type: MovementType.return_out,
            referenceType: 'purchase_return',
            referenceId: record.id,
            lotId: item.lotId,
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

      return tx.purchaseReturn.findUniqueOrThrow({
        where: { id: record.id },
        include: pvnInclude,
      });
    });

    return { data: serializePurchaseReturn(pvn) };
  }

  async findOne(id: bigint) {
    const pvn = await this.prisma.purchaseReturn.findUnique({
      where: { id },
      include: pvnInclude,
    });
    if (!pvn) throw new NotFoundException('Không tìm thấy phiếu trả hàng');
    return { data: serializePurchaseReturn(pvn) };
  }

  async confirmRefund(id: bigint, user: AuthUser) {
    const pvn = await this.prisma.purchaseReturn.findUnique({
      where: { id },
      include: { supplier: true, warehouse: true },
    });
    if (!pvn) throw new NotFoundException('Không tìm thấy phiếu trả hàng');
    if (pvn.refundStatus === RefundStatus.da_hoan_tien) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Phiếu trả đã nhận hoàn tiền',
        409,
      );
    }

    this.inventory.assertWarehouseAccess(user, pvn.warehouseId);

    const voucher = await this.prisma.$transaction(async (tx) => {
      await tx.purchaseReturn.update({
        where: { id },
        data: { refundStatus: RefundStatus.da_hoan_tien, refundedAt: new Date() },
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

      return this.vouchers.createReceipt(
        {
          branchId: pvn.warehouse.branchId,
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
      refund_status: RefundStatus.da_hoan_tien,
      voucher,
    };
  }

  /** Số lượng đã nhập của lô tại kho (từ REI đã xác nhận) trừ đã trả */
  async getReturnableQty(lotId: bigint, warehouseId: bigint) {
    const received = await this.prisma.goodsReceiptItem.aggregate({
      where: {
        lotId,
        goodsReceipt: {
          warehouseId,
          status: GoodsReceiptStatus.da_nhap,
        },
      },
      _sum: { quantity: true },
    });

    const returned = await this.prisma.purchaseReturnItem.aggregate({
      where: {
        lotId,
        purchaseReturn: { warehouseId },
      },
      _sum: { quantity: true },
    });

    return (received._sum.quantity ?? 0) - (returned._sum.quantity ?? 0);
  }

  private async validateReturnQuantities(
    items: CreatePurchaseReturnDto['items'],
    warehouseId: bigint,
  ) {
    const qtyByLot = new Map<string, number>();
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

      const key = item.lot_id;
      qtyByLot.set(key, (qtyByLot.get(key) ?? 0) + item.quantity);
    }

    for (const [lotId, qty] of qtyByLot) {
      const returnable = await this.getReturnableQty(
        BigInt(lotId),
        warehouseId,
      );
      if (qty > returnable) {
        throw new BusinessException(
          'RETURN_EXCEEDS_RECEIPT',
          `Trả vượt số đã nhập của lô (còn trả được ${returnable}, yêu cầu ${qty})`,
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
