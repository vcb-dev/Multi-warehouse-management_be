import { Injectable, NotFoundException } from '@nestjs/common';
import {
  GoodsReceiptStatus,
  InventoryBucket,
  MovementType,
  PaymentStatus,
  PoStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessException } from '../../common/exceptions/business.exception';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { InventoryService } from '../inventory/inventory.service';
import { VoucherService } from '../vouchers/voucher.service';
import { PurchaseOrderService } from './purchase-order.service';
import {
  CreateGoodsReceiptDto,
  ListGoodsReceiptsQueryDto,
} from './purchasing.dto';
import { serializeGoodsReceipt } from './purchasing.serializer';
import { generateSupplierLotCode, nextSupplierLotSequence, supplierLotPrefix } from './lot-code.util';

// DB ở xa (Supabase qua pooler) + transaction lặp qua nhiều dòng sản phẩm dễ
// vượt timeout mặc định 5s của Prisma interactive transaction.
const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 };

const reiInclude = {
  items: {
    include: {
      variant: { select: { sku: true } },
      lot: { select: { code: true } },
    },
  },
  supplier: { select: { code: true, name: true } },
  warehouse: { select: { code: true, name: true } },
  purchaseOrder: { select: { code: true } },
  assignedTo: { select: { name: true, email: true } },
} satisfies Prisma.GoodsReceiptInclude;

@Injectable()
export class GoodsReceiptService {
  constructor(
    private prisma: PrismaService,
    private inventory: InventoryService,
    private poService: PurchaseOrderService,
    private vouchers: VoucherService,
  ) {}

  async list(query: ListGoodsReceiptsQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const where: Prisma.GoodsReceiptWhereInput = {};

    if (query.status) {
      where.status = query.status as GoodsReceiptStatus;
    }
    if (query.supplier_id) {
      where.supplierId = BigInt(query.supplier_id);
    }
    if (query.payment_status) {
      const statuses = query.payment_status
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean) as PaymentStatus[];
      if (statuses.length) where.paymentStatus = { in: statuses };
    }
    if (query.date_from || query.date_to) {
      where.createdAt = {
        ...(query.date_from ? { gte: new Date(query.date_from) } : {}),
        ...(query.date_to ? { lte: new Date(query.date_to) } : {}),
      };
    }

    const [rows, total] = await Promise.all([
      this.prisma.goodsReceipt.findMany({
        where,
        include: reiInclude,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.goodsReceipt.count({ where }),
    ]);

    return {
      data: rows.map(serializeGoodsReceipt),
      total,
      page,
      page_size: pageSize,
    };
  }

  async findOne(id: bigint) {
    const rei = await this.prisma.goodsReceipt.findUnique({
      where: { id },
      include: reiInclude,
    });
    if (!rei) throw new NotFoundException('Không tìm thấy phiếu nhập');
    return { data: serializeGoodsReceipt(rei) };
  }

  async create(dto: CreateGoodsReceiptDto, user: AuthUser) {
    if (!dto.items?.length) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Phiếu nhập phải có ít nhất một dòng',
        422,
      );
    }

    const supplier = await this.getActiveSupplier(BigInt(dto.supplier_id));
    this.inventory.assertWarehouseAccess(user, BigInt(dto.warehouse_id));

    let purchaseOrder: Prisma.PurchaseOrderGetPayload<{
      include: { items: true };
    }> | null = null;

    if (dto.purchase_order_id) {
      purchaseOrder = await this.prisma.purchaseOrder.findUnique({
        where: { id: BigInt(dto.purchase_order_id) },
        include: { items: true },
      });
      if (!purchaseOrder) {
        throw new BusinessException(
          'VALIDATION_ERROR',
          'PO không tồn tại',
          422,
        );
      }
      if (purchaseOrder.status !== PoStatus.cho_nhap) {
        throw new BusinessException(
          'VALIDATION_ERROR',
          'PO phải ở trạng thái chờ nhập',
          422,
        );
      }
      if (purchaseOrder.supplierId !== BigInt(dto.supplier_id)) {
        throw new BusinessException(
          'VALIDATION_ERROR',
          'NCC không khớp với PO',
          422,
        );
      }
      if (purchaseOrder.warehouseId !== BigInt(dto.warehouse_id)) {
        throw new BusinessException(
          'VALIDATION_ERROR',
          'Kho không khớp với PO',
          422,
        );
      }
    }

    const code = await this.generateReiCode();

    const rei = await this.prisma.$transaction(async (tx) => {
      // Mã lô tự sinh theo NCC, dùng chung cho mọi dòng SP trong phiếu nhập này
      const prefix = supplierLotPrefix(supplier.name);
      const sequence = await nextSupplierLotSequence(tx, prefix);
      const lotCode = generateSupplierLotCode(supplier.name, sequence);

      const receipt = await tx.goodsReceipt.create({
        data: {
          code,
          supplierId: BigInt(dto.supplier_id),
          warehouseId: BigInt(dto.warehouse_id),
          purchaseOrderId: dto.purchase_order_id
            ? BigInt(dto.purchase_order_id)
            : null,
          status: GoodsReceiptStatus.chua_nhap,
          paymentStatus: PaymentStatus.chua_thanh_toan,
          createdById: user.userId,
          assignedToId: dto.assigned_to_id ? BigInt(dto.assigned_to_id) : null,
          expectedReceiptAt: dto.expected_receipt_at
            ? new Date(dto.expected_receipt_at)
            : null,
          invoiceAt: dto.invoice_at ? new Date(dto.invoice_at) : null,
          orderCode: dto.order_code?.trim() || null,
          referenceCode: dto.reference_code?.trim() || null,
          discountAmount: dto.discount_amount ?? 0,
          extraCost: dto.extra_cost ?? 0,
        },
      });

      for (const item of dto.items) {
        const lot = await this.upsertLot(tx, item, lotCode);
        await tx.goodsReceiptItem.create({
          data: {
            goodsReceiptId: receipt.id,
            variantId: BigInt(item.variant_id),
            lotId: lot.id,
            quantity: item.quantity,
            unitPrice: item.unit_price,
          },
        });
      }

      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'goods_receipt.create',
          entityType: 'goods_receipt',
          entityId: receipt.id,
          metadata: { code: receipt.code },
        },
      });

      return tx.goodsReceipt.findUniqueOrThrow({
        where: { id: receipt.id },
        include: reiInclude,
      });
    }, TX_OPTIONS);

    return { data: serializeGoodsReceipt(rei) };
  }

  async confirm(id: bigint, user: AuthUser) {
    const rei = await this.prisma.goodsReceipt.findUnique({
      where: { id },
      include: {
        items: true,
        purchaseOrder: { include: { items: true } },
      },
    });
    if (!rei) throw new NotFoundException('Không tìm thấy phiếu nhập');
    if (rei.status === GoodsReceiptStatus.da_nhap) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Phiếu nhập đã xác nhận',
        409,
      );
    }
    if (rei.status === GoodsReceiptStatus.huy) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Phiếu nhập đã hủy',
        409,
      );
    }

    this.inventory.assertWarehouseAccess(user, rei.warehouseId);

    const movementIds: bigint[] = [];
    let amountDue = 0;

    await this.prisma.$transaction(async (tx) => {
      const poItemMap = new Map(
        rei.purchaseOrder?.items.map((i) => [i.variantId.toString(), i]) ?? [],
      );

      // Gom theo variant để validate incoming còn lại trên PO
      const qtyByVariant = new Map<string, number>();
      for (const item of rei.items) {
        const key = item.variantId.toString();
        qtyByVariant.set(key, (qtyByVariant.get(key) ?? 0) + item.quantity);
      }

      if (rei.purchaseOrderId) {
        for (const [variantId, qty] of qtyByVariant) {
          const poItem = poItemMap.get(variantId);
          if (!poItem) {
            throw new BusinessException(
              'VALIDATION_ERROR',
              `Variant ${variantId} không có trên PO`,
              422,
            );
          }
          const remaining = poItem.quantity - poItem.receivedQuantity;
          if (qty > remaining) {
            throw new BusinessException(
              'INCOMING_EXCEEDS_PO',
              `Số lượng nhập vượt incoming còn lại (còn ${remaining}, nhập ${qty})`,
              422,
            );
          }
        }
      }

      for (const item of rei.items) {
        amountDue += item.quantity * Number(item.unitPrice);
        const movements: Parameters<InventoryService['applyMovements']>[0] = [];

        if (rei.purchaseOrderId) {
          movements.push({
            variantId: item.variantId,
            warehouseId: rei.warehouseId,
            bucket: InventoryBucket.incoming,
            change: -item.quantity,
            type: MovementType.incoming_receipt,
            referenceType: 'goods_receipt',
            referenceId: rei.id,
            lotId: item.lotId,
            createdById: user.userId,
          });
        }

        movements.push({
          variantId: item.variantId,
          warehouseId: rei.warehouseId,
          bucket: InventoryBucket.on_hand,
          change: item.quantity,
          type: MovementType.receipt,
          referenceType: 'goods_receipt',
          referenceId: rei.id,
          lotId: item.lotId,
          createdById: user.userId,
          cost: item.unitPrice,
        });

        const result = await this.inventory.applyMovements(movements, tx);
        movementIds.push(...result.movementIds);

        if (rei.purchaseOrderId) {
          const poItem = poItemMap.get(item.variantId.toString());
          if (poItem) {
            await tx.purchaseOrderItem.update({
              where: { id: poItem.id },
              data: {
                receivedQuantity: poItem.receivedQuantity + item.quantity,
              },
            });
            poItem.receivedQuantity += item.quantity;
          }
        }
      }

      amountDue =
        amountDue - Number(rei.discountAmount) + Number(rei.extraCost);

      // Cấn trừ tiền cọc đã đóng trên PO (nếu phiếu nhập gắn với PO có cọc)
      let depositApplied = 0;
      if (rei.purchaseOrderId) {
        const po = await tx.purchaseOrder.findUnique({
          where: { id: rei.purchaseOrderId },
          select: { depositAmount: true },
        });
        if (po && Number(po.depositAmount) > 0) {
          const used = await tx.goodsReceipt.aggregate({
            _sum: { depositApplied: true },
            where: {
              purchaseOrderId: rei.purchaseOrderId,
              id: { not: rei.id },
            },
          });
          const available =
            Number(po.depositAmount) - Number(used._sum.depositApplied ?? 0);
          depositApplied = Math.min(Math.max(available, 0), amountDue);
        }
      }
      const paymentStatus =
        depositApplied >= amountDue && amountDue > 0
          ? PaymentStatus.da_thanh_toan
          : depositApplied > 0
            ? PaymentStatus.mot_phan
            : PaymentStatus.chua_thanh_toan;

      await tx.goodsReceipt.update({
        where: { id: rei.id },
        data: {
          status: GoodsReceiptStatus.da_nhap,
          amountDue,
          receivedAt: new Date(),
          depositApplied,
          paidAmount: depositApplied,
          paymentStatus,
        },
      });

      if (rei.purchaseOrderId) {
        await this.poService.tryCompleteIfFullyReceived(
          rei.purchaseOrderId,
          user.userId,
          tx,
        );
      }

      await tx.supplierLedgerEntry.create({
        data: {
          supplierId: rei.supplierId,
          referenceType: 'goods_receipt',
          referenceCode: rei.code,
          transactionLabel: 'Nhập hàng',
          reason: 'Nhập hàng',
          amount: -amountDue,
          createdById: user.userId,
        },
      });

      if (depositApplied > 0) {
        await tx.supplierLedgerEntry.create({
          data: {
            supplierId: rei.supplierId,
            referenceType: 'payment',
            referenceCode: rei.code,
            transactionLabel: 'Trừ cọc',
            reason: 'Trừ tiền cọc đặt hàng nhập',
            amount: depositApplied,
            createdById: user.userId,
          },
        });
      }

      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'goods_receipt.confirm',
          entityType: 'goods_receipt',
          entityId: rei.id,
          metadata: { code: rei.code },
        },
      });
    }, TX_OPTIONS);

    return {
      id: rei.id.toString(),
      status: GoodsReceiptStatus.da_nhap,
      movement_ids: movementIds.map((m) => m.toString()),
      amount_due: amountDue.toString(),
    };
  }

  async pay(id: bigint, user: AuthUser, amount?: number) {
    const rei = await this.prisma.goodsReceipt.findUnique({
      where: { id },
      include: { supplier: true, warehouse: true },
    });
    if (!rei) throw new NotFoundException('Không tìm thấy phiếu nhập');
    if (rei.status !== GoodsReceiptStatus.da_nhap) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Chỉ thanh toán phiếu đã nhập',
        409,
      );
    }
    if (rei.paymentStatus === PaymentStatus.da_thanh_toan) {
      return {
        id: rei.id.toString(),
        payment_status: PaymentStatus.da_thanh_toan,
        paid_amount: rei.paidAmount.toString(),
      };
    }

    this.inventory.assertWarehouseAccess(user, rei.warehouseId);

    const remaining = Number(rei.amountDue) - Number(rei.paidAmount);
    const payAmount = amount ?? remaining;

    if (payAmount <= 0) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Số tiền thanh toán phải lớn hơn 0',
        422,
      );
    }
    if (payAmount > remaining) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        `Số tiền thanh toán vượt quá số tiền còn phải trả (còn ${remaining})`,
        422,
      );
    }

    const newPaidAmount = Number(rei.paidAmount) + payAmount;
    const newStatus =
      newPaidAmount >= Number(rei.amountDue)
        ? PaymentStatus.da_thanh_toan
        : PaymentStatus.mot_phan;

    const voucher = await this.prisma.$transaction(async (tx) => {
      await tx.goodsReceipt.update({
        where: { id },
        data: { paymentStatus: newStatus, paidAmount: newPaidAmount },
      });

      const result = await this.vouchers.createPayment(
        {
          branchId: rei.warehouse.branchId,
          amount: payAmount,
          createdById: user.userId,
          sourceDocument: rei.code,
          referenceType: 'goods_receipt',
          referenceId: rei.id,
          reason: `Thanh toán nhập hàng — NCC ${rei.supplier.name}`,
        },
        tx,
      );

      await tx.supplierLedgerEntry.create({
        data: {
          supplierId: rei.supplierId,
          referenceType: 'payment',
          referenceCode: rei.code,
          transactionLabel: 'Thanh toán',
          reason: 'Thanh toán nhập hàng',
          amount: payAmount,
          createdById: user.userId,
        },
      });

      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'goods_receipt.pay',
          entityType: 'goods_receipt',
          entityId: rei.id,
          metadata: { code: rei.code, amount: payAmount },
        },
      });

      return result;
    }, TX_OPTIONS);

    return {
      id: rei.id.toString(),
      payment_status: newStatus,
      paid_amount: newPaidAmount.toString(),
      voucher,
    };
  }

  async cancel(id: bigint, user: AuthUser) {
    const rei = await this.prisma.goodsReceipt.findUnique({ where: { id } });
    if (!rei) throw new NotFoundException('Không tìm thấy phiếu nhập');
    if (rei.status !== GoodsReceiptStatus.chua_nhap) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Chỉ hủy được phiếu nhập chưa nhập kho',
        409,
      );
    }

    this.inventory.assertWarehouseAccess(user, rei.warehouseId);

    // Phiếu "chưa nhập" chưa từng đụng vào tồn kho/công nợ nên hủy = xóa hẳn,
    // không giữ lại bản ghi "đã hủy" (khớp Sapo: chỉ có 2 trạng thái Đã nhập/Chưa nhập).
    await this.prisma.$transaction(async (tx) => {
      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'goods_receipt.cancel',
          entityType: 'goods_receipt',
          entityId: rei.id,
          metadata: { code: rei.code },
        },
      });

      await tx.goodsReceipt.delete({ where: { id } });
    }, TX_OPTIONS);

    return { id: rei.id.toString(), deleted: true };
  }

  private async upsertLot(
    tx: Prisma.TransactionClient,
    item: CreateGoodsReceiptDto['items'][0],
    code: string,
  ) {
    const variantId = BigInt(item.variant_id);
    const manufacturedAt = item.lot.manufactured_at
      ? new Date(item.lot.manufactured_at)
      : null;
    const expiredAt = item.lot.expired_at
      ? new Date(item.lot.expired_at)
      : null;

    if (manufacturedAt && expiredAt && expiredAt < manufacturedAt) {
      throw new BusinessException('VALIDATION_ERROR', 'HSD phải >= NSX', 422);
    }

    return tx.lot.upsert({
      where: {
        variantId_code: { variantId, code },
      },
      create: {
        variantId,
        code,
        manufacturedAt,
        expiredAt,
      },
      update: {},
    });
  }

  private async getActiveSupplier(id: bigint) {
    const s = await this.prisma.supplier.findUnique({ where: { id } });
    if (!s || !s.isActive) {
      throw new BusinessException('VALIDATION_ERROR', 'NCC không hợp lệ', 422);
    }
    return s;
  }

  private async generateReiCode() {
    // Dựa vào count() sẽ trùng mã sau khi phiếu nháp bị xóa hẳn (cancel), nên
    // phải lấy số thứ tự cao nhất đã từng cấp thay vì đếm số bản ghi còn lại.
    // Sắp theo chính "code" (không phải id) — thứ tự tạo record không đảm bảo
    // khớp thứ tự số trong code nếu dữ liệu cũ từng bị cấp lệch.
    const latest = await this.prisma.goodsReceipt.findFirst({
      orderBy: { code: 'desc' },
      select: { code: true },
    });
    const nextSeq = latest ? Number(latest.code.slice(3)) + 1 : 1;
    return `REI${String(nextSeq).padStart(6, '0')}`;
  }
}
