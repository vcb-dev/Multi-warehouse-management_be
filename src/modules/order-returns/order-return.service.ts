import { Injectable, NotFoundException } from '@nestjs/common';
import {
  CustomerLedgerReferenceType,
  InventoryBucket,
  MovementType,
  NotificationTopic,
  RestockType,
  OrderFulfillmentStatus,
  OrderStatus,
  Prisma,
} from '@prisma/client';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import {
  assertLocationPermission,
  locationScopeFilter,
} from '../../common/auth/access';
import { BusinessException } from '../../common/exceptions/business.exception';
import { InventoryService } from '../inventory/inventory.service';
import { sortForLocking } from '../inventory/inventory.types';
import { NotificationService } from '../notifications/notification.service';
import { VoucherService } from '../vouchers/voucher.service';
import { CustomerDebtService } from '../orders/customer-debt.service';
import { generateReturnCode } from '../orders/order-code';
import {
  CreateOrderReturnDto,
  ListOrderReturnsQueryDto,
} from '../orders/order.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { recomputeOrderRefundStatuses } from '../orders/order-refund-status';
import { serializeOrderReturnLine } from './order-return.serializer';

@Injectable()
export class OrderReturnService {
  constructor(
    private prisma: PrismaService,
    private inventory: InventoryService,
    private vouchers: VoucherService,
    private customerDebt: CustomerDebtService,
    private notifications: NotificationService,
  ) {}

  async list(query: ListOrderReturnsQueryDto, user: AuthUser) {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const where: Prisma.OrderRefundLineItemWhereInput = {};

    where.locationId = locationScopeFilter(user, 'order_return:view');

    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [
        { sku: { contains: q, mode: 'insensitive' } },
        { productName: { contains: q, mode: 'insensitive' } },
        {
          refund: {
            orderReturn: { code: { contains: q, mode: 'insensitive' } },
          },
        },
        {
          refund: { order: { name: { contains: q, mode: 'insensitive' } } },
        },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.orderRefundLineItem.findMany({
        where,
        orderBy: { refund: { createdOn: 'desc' } },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          refund: {
            include: {
              order: { include: { location: true } },
              orderReturn: true,
              createdBy: true,
            },
          },
        },
      }),
      this.prisma.orderRefundLineItem.count({ where }),
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
    assertLocationPermission(user, 'order_return:manage', order.locationId);
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
      assertLocationPermission(
        user,
        'order_return:manage',
        BigInt(item.location_id),
      );
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
      // Sapo: phiếu trả hàng (`return`) chỉ giữ mã + lý do; tiền và việc nhập
      // kho nằm ở bản ghi `refund` trỏ về nó qua `return_id`.
      const ret = await tx.orderReturn.create({
        data: {
          code,
          orderId,
          reason: dto.reason?.trim() || null,
          createdById: user.userId,
        },
      });

      const refund = await tx.orderRefund.create({
        data: {
          orderId,
          returnId: ret.id,
          note: dto.reason?.trim() || null,
          restock,
          totalRefunded: dto.refund_amount,
          createdById: user.userId,
          lineItems: {
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
                orderItemId: oi?.id ?? null,
                variantId: BigInt(i.variant_id),
                locationId: BigInt(i.location_id),
                productName: oi?.name ?? variant?.product.name ?? '',
                sku: oi?.sku ?? variant?.sku ?? '',
                variantTitle,
                quantity: i.quantity,
                price: i.price,
                subtotal: i.price * i.quantity,
                // Khách trả hàng: nhập lại kho -> `return_item`, không nhập -> `no_restock`
                restockType: restock
                  ? RestockType.return_item
                  : RestockType.no_restock,
              };
            }),
          },
        },
        include: { lineItems: true },
      });

      if (restock) {
        for (const item of sortForLocking(refund.lineItems)) {
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
      let voucher: Awaited<ReturnType<VoucherService['createPayment']>> | null =
        null;

      if (dto.refund_amount > 0) {
        if (deductFromDebt) {
          await this.customerDebt.recordEntry(
            {
              customerId: order.customerId!,
              referenceType: CustomerLedgerReferenceType.order_return,
              referenceCode: ret.code,
              transactionLabel: 'Trả hàng — trừ công nợ',
              reason: dto.reason?.trim() || `Trả hàng đơn ${order.name}`,
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
              sourceDocument: order.name,
              referenceType: 'order_return',
              referenceId: ret.id,
              reason: dto.reason?.trim() || `Hoàn tiền đơn ${order.name}`,
            },
            tx,
          );
        }
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

      await recomputeOrderRefundStatuses(tx, orderId);

      return { ret, refund, voucher };
    });

    // subjectId là id của REFUND (khớp topic `refunds/create` bên Sapo), nên phải kèm
    // `order_id` trong payload — không có nó thì serializer không dựng được link.
    void this.notifications.emit(NotificationTopic.refunds_create, {
      subjectType: 'order_refund',
      subjectId: record.refund.id,
      locationId: order.locationId,
      title: `Trả hàng ${record.ret.code} — hoàn ${Number(
        record.refund.totalRefunded,
      ).toLocaleString('vi-VN')}đ (đơn ${order.name})`,
      payload: {
        code: record.ret.code,
        order_id: orderId.toString(),
        order_code: order.name,
        refund_amount: Number(record.refund.totalRefunded),
        deduct_from_debt: deductFromDebt,
      },
    });

    return {
      id: record.ret.id.toString(),
      code: record.ret.code,
      refund_amount: Number(record.refund.totalRefunded),
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

    const returned = await this.prisma.orderRefundLineItem.groupBy({
      by: ['variantId', 'locationId'],
      where: { refund: { orderId } },
      _sum: { quantity: true },
    });
    const already = new Map<string, number>();
    for (const r of returned) {
      already.set(`${r.variantId}:${r.locationId}`, r._sum.quantity ?? 0);
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
