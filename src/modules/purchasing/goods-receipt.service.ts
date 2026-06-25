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

    await this.validateSupplier(BigInt(dto.supplier_id));
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
        throw new BusinessException('VALIDATION_ERROR', 'PO không tồn tại', 422);
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
        },
      });

      for (const item of dto.items) {
        const lot = await this.upsertLot(tx, item);
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

      return tx.goodsReceipt.findUniqueOrThrow({
        where: { id: receipt.id },
        include: reiInclude,
      });
    });

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

      await tx.goodsReceipt.update({
        where: { id: rei.id },
        data: {
          status: GoodsReceiptStatus.da_nhap,
          amountDue,
          receivedAt: new Date(),
        },
      });

      if (rei.purchaseOrderId) {
        await this.poService.tryCompleteIfFullyReceived(
          rei.purchaseOrderId,
          tx,
        );
      }
    });

    return {
      id: rei.id.toString(),
      status: GoodsReceiptStatus.da_nhap,
      movement_ids: movementIds.map((m) => m.toString()),
      amount_due: amountDue.toString(),
    };
  }

  async pay(id: bigint, user: AuthUser) {
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
      };
    }

    this.inventory.assertWarehouseAccess(user, rei.warehouseId);

    const amount = Number(rei.amountDue);
    const voucher = await this.prisma.$transaction(async (tx) => {
      await tx.goodsReceipt.update({
        where: { id },
        data: { paymentStatus: PaymentStatus.da_thanh_toan },
      });

      return this.vouchers.createPayment(
        {
          branchId: rei.warehouse.branchId,
          amount,
          createdById: user.userId,
          sourceDocument: rei.code,
          referenceType: 'goods_receipt',
          referenceId: rei.id,
          reason: `Thanh toán nhập hàng — NCC ${rei.supplier.name}`,
        },
        tx,
      );
    });

    return {
      id: rei.id.toString(),
      payment_status: PaymentStatus.da_thanh_toan,
      voucher,
    };
  }

  private async upsertLot(
    tx: Prisma.TransactionClient,
    item: CreateGoodsReceiptDto['items'][0],
  ) {
    const variantId = BigInt(item.variant_id);
    const manufacturedAt = item.lot.manufactured_at
      ? new Date(item.lot.manufactured_at)
      : null;
    const expiredAt = item.lot.expired_at
      ? new Date(item.lot.expired_at)
      : null;

    if (manufacturedAt && expiredAt && expiredAt < manufacturedAt) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'HSD phải >= NSX',
        422,
      );
    }

    return tx.lot.upsert({
      where: {
        variantId_code: { variantId, code: item.lot.code.trim() },
      },
      create: {
        variantId,
        code: item.lot.code.trim(),
        manufacturedAt,
        expiredAt,
      },
      update: {},
    });
  }

  private async validateSupplier(id: bigint) {
    const s = await this.prisma.supplier.findUnique({ where: { id } });
    if (!s || !s.isActive) {
      throw new BusinessException('VALIDATION_ERROR', 'NCC không hợp lệ', 422);
    }
  }

  private async generateReiCode() {
    const count = await this.prisma.goodsReceipt.count();
    return `REI${String(count + 1).padStart(6, '0')}`;
  }
}
