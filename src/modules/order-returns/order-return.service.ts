import { Injectable, NotFoundException } from '@nestjs/common';
import {
  CustomerLedgerReferenceType,
  InventoryBucket,
  MovementType,
  OrderStatus,
  Prisma,
} from '@prisma/client';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import {
  assertAnyWarehouseAccess,
  assertWarehouseAccess,
} from '../../common/auth/access';
import { BusinessException } from '../../common/exceptions/business.exception';
import { InventoryService } from '../inventory/inventory.service';
import { sortForLocking } from '../inventory/inventory.types';
import { VoucherService } from '../vouchers/voucher.service';
import { CustomerDebtService } from '../orders/customer-debt.service';
import { generateReturnCode } from '../orders/order-code';
import { CreateOrderReturnDto, ListOrderReturnsQueryDto } from '../orders/order.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { serializeOrderReturnLine } from './order-return.serializer';

@Injectable()
export class OrderReturnService {
  constructor(
    private prisma: PrismaService,
    private inventory: InventoryService,
    private vouchers: VoucherService,
    private customerDebt: CustomerDebtService,
  ) {}

  async list(query: ListOrderReturnsQueryDto, user: AuthUser) {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const where: Prisma.OrderReturnItemWhereInput = {};

    where.warehouseId = { in: user.warehouseIds };

    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [
        { sku: { contains: q, mode: 'insensitive' } },
        { productName: { contains: q, mode: 'insensitive' } },
        { orderReturn: { code: { contains: q, mode: 'insensitive' } } },
        {
          orderReturn: {
            order: { code: { contains: q, mode: 'insensitive' } },
          },
        },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.orderReturnItem.findMany({
        where,
        orderBy: { orderReturn: { createdAt: 'desc' } },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          orderReturn: {
            include: {
              order: { include: { branch: true } },
              createdBy: true,
            },
          },
        },
      }),
      this.prisma.orderReturnItem.count({ where }),
    ]);

    return {
      data: rows.map(serializeOrderReturnLine),
      total,
      page,
      page_size: pageSize,
    };
  }

  async create(dto: CreateOrderReturnDto, user: AuthUser) {
    const orderId = BigInt(dto.order_id);
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn');
    assertAnyWarehouseAccess(
      user,
      order.items.map((i) => i.warehouseId),
    );
    if (order.status !== OrderStatus.completed) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Chỉ trả hàng trên đơn đã hoàn thành',
        409,
      );
    }

    await this.validateReturnQty(orderId, dto);

    for (const item of dto.items) {
      assertWarehouseAccess(user, BigInt(item.warehouse_id));
    }

    const orderItemMap = new Map(
      order.items.map((i) => [`${i.variantId}:${i.warehouseId}`, i]),
    );

    const variantIds = [...new Set(dto.items.map((i) => BigInt(i.variant_id)))];
    const variants = await this.prisma.productVariant.findMany({
      where: { id: { in: variantIds } },
      include: {
        product: true,
        optionValues: { include: { option: true } },
      },
    });
    const variantMap = new Map(variants.map((v) => [v.id.toString(), v]));

    const code = await generateReturnCode(this.prisma);
    const restock = dto.restock ?? true;
    const deductFromDebt = dto.deduct_from_debt ?? false;

    if (deductFromDebt && !order.customerId) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Đơn không có khách hàng — không thể trừ công nợ, hãy hoàn tiền ngay',
        422,
      );
    }

    const record = await this.prisma.$transaction(async (tx) => {
      const ret = await tx.orderReturn.create({
        data: {
          code,
          orderId,
          reason: dto.reason?.trim() || null,
          refundAmount: dto.refund_amount,
          restock,
          createdById: user.userId,
          items: {
            create: dto.items.map((i) => {
              const key = `${i.variant_id}:${i.warehouse_id}`;
              const oi = orderItemMap.get(key);
              const variant = variantMap.get(i.variant_id);
              const variantTitle = variant
                ? variant.optionValues
                    .sort((a, b) => a.option.position - b.option.position)
                    .map((ov) => ov.value)
                    .join(' / ') || null
                : null;
              return {
                variantId: BigInt(i.variant_id),
                warehouseId: BigInt(i.warehouse_id),
                productName: oi?.productName ?? variant?.product.name ?? '',
                sku: oi?.sku ?? variant?.sku ?? '',
                variantTitle,
                quantity: i.quantity,
                price: i.price,
              };
            }),
          },
        },
        include: { items: true },
      });

      if (restock) {
        for (const item of sortForLocking(ret.items)) {
          await this.inventory.applyMovement(
            {
              variantId: item.variantId,
              warehouseId: item.warehouseId,
              bucket: InventoryBucket.on_hand,
              change: item.quantity,
              type: MovementType.return_in,
              referenceType: 'order_return',
              referenceId: ret.id,
              createdById: user.userId,
            },
            tx,
          );
        }
      }

      // 2 lựa chọn như Sapo: trừ vào công nợ KH (không chi tiền)
      // hoặc hoàn tiền ngay (phiếu chi, công nợ không đổi)
      let voucher: Awaited<
        ReturnType<VoucherService['createPayment']>
      > | null = null;

      if (deductFromDebt) {
        await this.customerDebt.recordEntry(
          {
            customerId: order.customerId!,
            referenceType: CustomerLedgerReferenceType.order_return,
            referenceCode: ret.code,
            transactionLabel: 'Trả hàng — trừ công nợ',
            reason: dto.reason?.trim() || `Trả hàng đơn ${order.code}`,
            amount: -dto.refund_amount,
            createdById: user.userId,
          },
          tx,
        );
      } else {
        voucher = await this.vouchers.createPayment(
          {
            branchId: order.branchId,
            amount: dto.refund_amount,
            createdById: user.userId,
            sourceDocument: order.code,
            referenceType: 'order_return',
            referenceId: ret.id,
            reason: dto.reason?.trim() || `Hoàn tiền đơn ${order.code}`,
          },
          tx,
        );
      }

      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: deductFromDebt ? 'debt.deduct' : 'voucher.refund',
          entityType: 'order_return',
          entityId: ret.id,
          metadata: {
            order_id: orderId.toString(),
            refund_amount: dto.refund_amount,
            code: ret.code,
            ...(voucher
              ? { voucher_id: voucher.id, voucher_code: voucher.code }
              : { deduct_from_debt: true }),
          },
        },
      });

      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.returned },
      });

      return { ret, voucher };
    });

    return {
      id: record.ret.id.toString(),
      code: record.ret.code,
      refund_amount: Number(record.ret.refundAmount),
      voucher: record.voucher,
    };
  }

  private async validateReturnQty(orderId: bigint, dto: CreateOrderReturnDto) {
    const orderItems = await this.prisma.orderItem.findMany({
      where: { orderId },
    });
    const purchased = new Map<string, number>();
    for (const i of orderItems) {
      const key = `${i.variantId}:${i.warehouseId}`;
      purchased.set(key, (purchased.get(key) ?? 0) + i.quantity);
    }

    const returned = await this.prisma.orderReturnItem.groupBy({
      by: ['variantId', 'warehouseId'],
      where: { orderReturn: { orderId } },
      _sum: { quantity: true },
    });
    const already = new Map<string, number>();
    for (const r of returned) {
      already.set(
        `${r.variantId}:${r.warehouseId}`,
        r._sum.quantity ?? 0,
      );
    }

    const req = new Map<string, number>();
    for (const item of dto.items) {
      const key = `${item.variant_id}:${item.warehouse_id}`;
      req.set(key, (req.get(key) ?? 0) + item.quantity);
    }

    for (const [key, qty] of req) {
      const max = (purchased.get(key) ?? 0) - (already.get(key) ?? 0);
      if (qty > max) {
        throw new BusinessException(
          'RETURN_EXCEEDS_ORDER',
          `Trả vượt số đã mua (còn trả được ${max}, yêu cầu ${qty})`,
          409,
        );
      }
    }
  }
}
