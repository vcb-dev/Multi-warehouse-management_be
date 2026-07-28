import { Injectable, NotFoundException } from '@nestjs/common';
import {
  CustomerLedgerReferenceType,
  InventoryBucket,
  MovementType,
  OrderFulfillmentStatus,
  OrderRefundStatus,
  OrderReturnStatus,
  OrderStatus,
  Prisma,
} from '@prisma/client';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import {
  assertAnyLocationAccess,
  assertLocationAccess,
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

    where.locationId = { in: user.locationIds };

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
              order: { include: { location: true } },
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
    assertAnyLocationAccess(user, [order.locationId]);
    // "Đã hoàn thành" thực tế = đã giao hàng (fulfillment_status='fulfilled'),
    // KHÔNG phải status='closed' — dữ liệu Sapo thật cho thấy phần lớn đơn đã
    // giao vẫn ở status='open' (Sapo hiếm khi đóng đơn về mặt hành chính).
    const isFulfilled =
      order.fulfillmentStatus === OrderFulfillmentStatus.fulfilled ||
      order.status === OrderStatus.closed;
    if (!isFulfilled) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Chỉ trả hàng trên đơn đã hoàn thành',
        409,
      );
    }

    await this.validateReturnQty(orderId, dto);

    for (const item of dto.items) {
      assertLocationAccess(user, BigInt(item.location_id));
    }

    const orderItemMap = new Map(
      order.items.map((i) => [`${i.variantId}:${order.locationId}`, i]),
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
              const key = `${i.variant_id}:${i.location_id}`;
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
                locationId: BigInt(i.location_id),
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
              locationId: item.locationId,
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
            locationId: order.locationId,
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

      // return_status/refund_status độc lập với status (theo Sapo) — không còn
      // ghi đè status='returned' như trước (điều đó xóa mất việc đơn đã 'closed').
      const totalOrderedQty = order.items.reduce((s, i) => s + i.quantity, 0);
      const returnedAgg = await tx.orderReturnItem.aggregate({
        where: { orderReturn: { orderId } },
        _sum: { quantity: true },
      });
      const totalReturnedQty = returnedAgg._sum.quantity ?? 0;
      const returnStatus =
        totalReturnedQty >= totalOrderedQty
          ? OrderReturnStatus.returned
          : OrderReturnStatus.in_progress;

      const refundAgg = await tx.orderReturn.aggregate({
        where: { orderId },
        _sum: { refundAmount: true },
      });
      const totalRefunded = Number(refundAgg._sum.refundAmount ?? 0);
      const refundStatus =
        totalRefunded >= Number(order.totalAmount)
          ? OrderRefundStatus.refunded
          : totalRefunded > 0
            ? OrderRefundStatus.partial
            : OrderRefundStatus.no_refund;

      await tx.order.update({
        where: { id: orderId },
        data: { returnStatus, refundStatus },
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
    // Location ở cấp đơn (theo Sapo) nên mọi dòng hàng đều thuộc cùng một kho.
    const { locationId } = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { locationId: true },
    });
    const orderItems = await this.prisma.orderItem.findMany({
      where: { orderId },
    });
    const purchased = new Map<string, number>();
    for (const i of orderItems) {
      const key = `${i.variantId}:${locationId}`;
      purchased.set(key, (purchased.get(key) ?? 0) + i.quantity);
    }

    const returned = await this.prisma.orderReturnItem.groupBy({
      by: ['variantId', 'locationId'],
      where: { orderReturn: { orderId } },
      _sum: { quantity: true },
    });
    const already = new Map<string, number>();
    for (const r of returned) {
      already.set(
        `${r.variantId}:${r.locationId}`,
        r._sum.quantity ?? 0,
      );
    }

    const req = new Map<string, number>();
    for (const item of dto.items) {
      const key = `${item.variant_id}:${item.location_id}`;
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
