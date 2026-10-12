import { Injectable, NotFoundException } from '@nestjs/common';
import {
  CustomerLedgerReferenceType,
  InventoryBucket,
  MovementType,
  NotificationTopic,
  RestockType,
  OrderFulfillmentStatus,
  OrderReturnDocStatus,
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
import { CustomerDebtService } from '../customers/customer-debt.service';
import { generateReturnCode } from '../orders/order-code';
import {
  CreateOrderReturnDto,
  ListOrderReturnsQueryDto,
  ListReturnDocumentsQueryDto,
  ReceiveOrderReturnDto,
  RefundOrderReturnDto,
} from '../orders/order.dto';
import { parseEnumList, parseIdList } from '../../common/query/filter-params';
import { PrismaService } from '../../prisma/prisma.service';
import { recomputeOrderRefundStatuses } from '../orders/order-refund-status';
import { IN_FLIGHT_FULFILLMENT_WHERE } from '../orders/order-completion';
import {
  isAppManagedReturn,
  returnDocumentInclude,
  serializeOrderReturnLine,
  serializeReturnDocument,
} from './order-return.serializer';

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

  /** Danh sách PHIẾU trả hàng — mỗi phiếu một dòng, kèm trạng thái từng bước. */
  async listDocuments(query: ListReturnDocumentsQueryDto, user: AuthUser) {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const where: Prisma.OrderReturnWhereInput = {};

    const locationIds = parseIdList(query.location_ids);
    if (locationIds) {
      for (const locationId of locationIds) {
        assertLocationPermission(user, 'order_return:view', locationId);
      }
      where.order = { locationId: { in: locationIds } };
    } else {
      const scope = locationScopeFilter(user, 'order_return:view');
      if (scope) where.order = { locationId: scope };
    }

    const statuses = parseEnumList(
      query.status,
      Object.values(OrderReturnDocStatus),
    );
    if (statuses) where.status = { in: statuses };

    const q = query.q?.trim();
    if (q) {
      where.OR = [
        { code: { contains: q, mode: 'insensitive' } },
        { trackingNumber: { contains: q, mode: 'insensitive' } },
        { order: { name: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.orderReturn.findMany({
        where,
        orderBy: [{ createdOn: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: returnDocumentInclude,
      }),
      this.prisma.orderReturn.count({ where }),
    ]);
    return {
      data: rows.map(serializeReturnDocument),
      total,
      page,
      page_size: pageSize,
    };
  }

  async findDocument(id: bigint, user: AuthUser) {
    const ret = await this.prisma.orderReturn.findUnique({
      where: { id },
      include: returnDocumentInclude,
    });
    if (!ret) throw new NotFoundException('Không tìm thấy phiếu trả hàng');
    assertLocationPermission(user, 'order_return:view', ret.order.locationId);
    return serializeReturnDocument(ret);
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
    // `fulfilled` chỉ nói đơn đã có kiện hàng — kiện còn trên đường thì khách
    // chưa cầm hàng để mà trả.
    const inFlight = await this.prisma.fulfillment.count({
      where: { orderId, ...IN_FLIGHT_FULFILLMENT_WHERE },
    });
    if (inFlight) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Đơn đang giao hàng — chỉ trả hàng sau khi giao xong',
        409,
      );
    }
    await this.validateReturnQty(orderId, dto);
    await this.validateRefundAmount(order, dto.refund_amount);

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

    // Client cũ không gửi hai cờ này và trông đợi lập phiếu là xong.
    const receiveNow = dto.receive_now ?? true;
    const refundNow = dto.refund_now ?? true;
    const deductFromDebt = dto.deduct_from_debt ?? false;
    if (refundNow && dto.refund_amount > 0) {
      this.assertCanDeductDebt(deductFromDebt, order.customerId);
    }

    const record = await this.prisma.$transaction(async (tx) => {
      // Cấp mã BÊN TRONG transaction: khoá advisory của `generateReturnCode` chỉ
      // giữ tới lúc commit nên gọi ở ngoài thì hai phiếu tạo đồng thời vẫn trùng mã.
      const code = await generateReturnCode(tx);
      const created = await tx.orderReturn.create({
        data: {
          code,
          orderId,
          reasonCode: dto.reason_code ?? null,
          reason: dto.reason?.trim() || null,
          refundAmount: dto.refund_amount,
          trackingNumber: dto.tracking_number?.trim() || null,
          carrierName: dto.carrier_name?.trim() || null,
          createdById: user.userId,
          lineItems: {
            create: dto.items.map((i) => {
              const oi = orderItemMap.get(`${i.variant_id}:${i.location_id}`);
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
              };
            }),
          },
        },
      });
      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'order_return.create',
          entityType: 'order_return',
          entityId: created.id,
          metadata: {
            order_id: orderId.toString(),
            code,
            refund_amount: dto.refund_amount,
          },
        },
      });

      if (receiveNow) {
        await this.applyReceive(tx, created.id, dto.restock ?? true, user);
      }
      const refunded =
        refundNow && dto.refund_amount > 0
          ? await this.applyRefund(
              tx,
              created.id,
              dto.refund_amount,
              deductFromDebt,
              user,
            )
          : null;
      await this.settle(tx, created.id);
      return { ret: created, refunded };
    });

    if (record.refunded)
      this.notifyRefund(record.refunded, order, deductFromDebt);

    return {
      id: record.ret.id.toString(),
      code: record.ret.code,
      refund_amount: Number(record.refunded?.amount ?? 0),
      voucher: record.refunded?.voucher ?? null,
    };
  }

  /** Bước "Nhận hàng": hàng trả đã về tới kho. */
  async receive(id: bigint, dto: ReceiveOrderReturnDto, user: AuthUser) {
    await this.loadManaged(id, user);
    await this.prisma.$transaction(async (tx) => {
      await this.applyReceive(tx, id, dto.restock ?? true, user);
      await this.settle(tx, id);
    });
    return this.findDocument(id, user);
  }

  /** Bước "Hoàn tiền": chi tiền (phiếu chi) hoặc trừ vào công nợ khách. */
  async refund(id: bigint, dto: RefundOrderReturnDto, user: AuthUser) {
    const ret = await this.loadManaged(id, user);
    const deductFromDebt = dto.deduct_from_debt ?? false;
    this.assertCanDeductDebt(deductFromDebt, ret.order.customerId);
    const remaining = Number(ret.refundAmount) - Number(ret.refundedAmount);
    const amount = dto.amount ?? remaining;
    const refunded = await this.prisma.$transaction(async (tx) => {
      const result = await this.applyRefund(
        tx,
        id,
        amount,
        deductFromDebt,
        user,
      );
      await this.settle(tx, id);
      return result;
    });
    this.notifyRefund(refunded, ret.order, deductFromDebt);
    return this.findDocument(id, user);
  }

  /** Huỷ phiếu — chỉ khi chưa có gì xảy ra thật (chưa nhận hàng, chưa hoàn tiền). */
  async cancel(id: bigint, user: AuthUser) {
    const ret = await this.loadManaged(id, user);
    if (ret.receivedOn || Number(ret.refundedAmount) > 0) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Phiếu đã nhận hàng hoặc đã hoàn tiền, không thể hủy',
        409,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.orderReturn.update({
        where: { id },
        data: {
          status: OrderReturnDocStatus.cancelled,
          cancelledOn: new Date(),
        },
      });
      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'order_return.cancel',
          entityType: 'order_return',
          entityId: id,
          metadata: { order_id: ret.orderId.toString(), code: ret.code },
        },
      });
      await recomputeOrderRefundStatuses(tx, ret.orderId);
    });
    return this.findDocument(id, user);
  }

  /**
   * Chốt phiếu dù chưa hoàn đủ số dự kiến (shop và khách thoả thuận không hoàn
   * thêm). Phải nhận hàng trước — phiếu chưa nhận hàng thì huỷ chứ không chốt.
   */
  async complete(id: bigint, user: AuthUser) {
    const ret = await this.loadManaged(id, user);
    if (!ret.receivedOn) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Nhận hàng trước khi hoàn thành phiếu trả',
        409,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.orderReturn.update({
        where: { id },
        data: {
          status: OrderReturnDocStatus.completed,
          completedOn: new Date(),
        },
      });
      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'order_return.complete',
          entityType: 'order_return',
          entityId: id,
          metadata: { order_id: ret.orderId.toString(), code: ret.code },
        },
      });
      await recomputeOrderRefundStatuses(tx, ret.orderId);
    });
    return this.findDocument(id, user);
  }

  /**
   * Nạp phiếu cho một thao tác thủ công. Chỉ phiếu lập trong app (mã `RTN…`) và
   * đang xử lý mới thao tác được: phiếu chép từ sàn/Sapo (`TTR-…`, `RT-SAPO-…`)
   * do bên đó điều khiển, sửa ở đây sẽ lệch với nguồn ở lần đồng bộ kế tiếp.
   */
  private async loadManaged(id: bigint, user: AuthUser) {
    const ret = await this.prisma.orderReturn.findUnique({
      where: { id },
      include: {
        order: {
          select: { id: true, name: true, locationId: true, customerId: true },
        },
      },
    });
    if (!ret) throw new NotFoundException('Không tìm thấy phiếu trả hàng');
    assertLocationPermission(user, 'order_return:manage', ret.order.locationId);
    if (!isAppManagedReturn(ret.code)) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Phiếu trả do sàn/Sapo quản lý, không thao tác tại đây',
        409,
      );
    }
    if (ret.status !== OrderReturnDocStatus.in_progress) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Phiếu trả đã hoàn thành hoặc đã hủy',
        409,
      );
    }
    return ret;
  }

  private assertCanDeductDebt(
    deductFromDebt: boolean,
    customerId: bigint | null,
  ) {
    if (deductFromDebt && !customerId) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Đơn không có khách hàng — không thể trừ công nợ, hãy hoàn tiền ngay',
        422,
      );
    }
  }

  /**
   * Bản ghi `refund` của phiếu. Sapo: phiếu trả (`return`) chỉ giữ mã + lý do,
   * tiền và việc nhập kho nằm ở `refund` trỏ về nó qua `return_id`. Mỗi phiếu
   * một refund — bước nhận hàng gắn dòng hàng, bước hoàn tiền cộng tiền vào —
   * để danh sách dòng hoàn vẫn thấy tiền và hàng trên cùng một bản ghi.
   */
  private async refundRecordOf(
    tx: Prisma.TransactionClient,
    ret: { id: bigint; orderId: bigint; reason: string | null },
    user: AuthUser,
  ) {
    const existing = await tx.orderRefund.findFirst({
      where: { returnId: ret.id },
      orderBy: { id: 'asc' },
    });
    return (
      existing ??
      tx.orderRefund.create({
        data: {
          orderId: ret.orderId,
          returnId: ret.id,
          note: ret.reason,
          restock: false,
          totalRefunded: 0,
          createdById: user.userId,
        },
      })
    );
  }

  private async applyReceive(
    tx: Prisma.TransactionClient,
    id: bigint,
    restock: boolean,
    user: AuthUser,
  ) {
    const ret = await tx.orderReturn.findUniqueOrThrow({
      where: { id },
      include: { lineItems: true },
    });
    if (ret.receivedOn) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Phiếu trả đã nhận hàng',
        409,
      );
    }
    const refund = await this.refundRecordOf(tx, ret, user);
    await tx.orderRefund.update({
      where: { id: refund.id },
      data: {
        restock,
        lineItems: {
          create: ret.lineItems.map((l) => ({
            orderItemId: l.orderItemId,
            variantId: l.variantId,
            locationId: l.locationId,
            productName: l.productName,
            sku: l.sku,
            variantTitle: l.variantTitle,
            quantity: l.quantity,
            price: l.price,
            subtotal: l.subtotal,
            // Khách trả hàng: nhập lại kho -> `return_item`, không nhập -> `no_restock`
            restockType: restock
              ? RestockType.return_item
              : RestockType.no_restock,
          })),
        },
      },
    });
    if (restock) {
      for (const item of sortForLocking(ret.lineItems)) {
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
    await tx.orderReturn.update({
      where: { id },
      data: {
        receivedOn: new Date(),
        receivedById: user.userId,
        restocked: restock,
      },
    });
    await tx.activityLog.create({
      data: {
        userId: user.userId,
        action: 'order_return.receive',
        entityType: 'order_return',
        entityId: id,
        metadata: {
          order_id: ret.orderId.toString(),
          code: ret.code,
          restock,
        },
      },
    });
  }

  private async applyRefund(
    tx: Prisma.TransactionClient,
    id: bigint,
    amount: number,
    deductFromDebt: boolean,
    user: AuthUser,
  ) {
    const ret = await tx.orderReturn.findUniqueOrThrow({
      where: { id },
      include: {
        order: {
          select: { name: true, locationId: true, customerId: true },
        },
      },
    });
    const remaining = Number(ret.refundAmount) - Number(ret.refundedAmount);
    if (amount <= 0 || amount > remaining) {
      throw new BusinessException(
        'REFUND_EXCEEDS_RETURN',
        `Số tiền hoàn không hợp lệ (phiếu còn hoàn được ${remaining}, yêu cầu ${amount})`,
        422,
      );
    }
    // 2 lựa chọn như Sapo: trừ vào công nợ KH (không chi tiền)
    // hoặc hoàn tiền ngay (phiếu chi, công nợ không đổi)
    let voucher: Awaited<ReturnType<VoucherService['createPayment']>> | null =
      null;
    if (deductFromDebt) {
      await this.customerDebt.recordEntry(
        {
          customerId: ret.order.customerId!,
          referenceType: CustomerLedgerReferenceType.order_return,
          referenceCode: ret.code,
          transactionLabel: 'Trả hàng — trừ công nợ',
          reason: ret.reason || `Trả hàng đơn ${ret.order.name}`,
          amount: -amount,
          createdById: user.userId,
        },
        tx,
      );
    } else {
      voucher = await this.vouchers.createPayment(
        {
          locationId: ret.order.locationId,
          amount,
          createdById: user.userId,
          sourceDocument: ret.order.name,
          referenceType: 'order_return',
          referenceId: ret.id,
          reason: ret.reason || `Hoàn tiền đơn ${ret.order.name}`,
        },
        tx,
      );
    }
    const refund = await this.refundRecordOf(tx, ret, user);
    await tx.orderRefund.update({
      where: { id: refund.id },
      data: { totalRefunded: { increment: amount } },
    });
    await tx.orderReturn.update({
      where: { id },
      data: {
        refundedAmount: { increment: amount },
        refundedOn: new Date(),
        refundedById: user.userId,
      },
    });
    await tx.activityLog.create({
      data: {
        userId: user.userId,
        action: deductFromDebt ? 'debt.deduct' : 'voucher.refund',
        entityType: 'order_return',
        entityId: ret.id,
        metadata: {
          order_id: ret.orderId.toString(),
          refund_amount: amount,
          code: ret.code,
          ...(voucher
            ? { voucher_id: voucher.id, voucher_code: voucher.code }
            : { deduct_from_debt: true }),
        },
      },
    });
    return { refundId: refund.id, code: ret.code, amount, voucher };
  }

  /**
   * Sau mỗi bước: phiếu tự hoàn thành khi đã nhận hàng VÀ đã hoàn đủ số dự kiến,
   * rồi tính lại các trạng thái tổng hợp trên đơn.
   */
  private async settle(tx: Prisma.TransactionClient, id: bigint) {
    const ret = await tx.orderReturn.findUniqueOrThrow({ where: { id } });
    if (
      ret.status === OrderReturnDocStatus.in_progress &&
      ret.receivedOn &&
      Number(ret.refundedAmount) >= Number(ret.refundAmount)
    ) {
      await tx.orderReturn.update({
        where: { id },
        data: {
          status: OrderReturnDocStatus.completed,
          completedOn: new Date(),
        },
      });
    }
    await recomputeOrderRefundStatuses(tx, ret.orderId);
  }

  private notifyRefund(
    refunded: { refundId: bigint; code: string; amount: number },
    order: { id: bigint; name: string; locationId: bigint },
    deductFromDebt: boolean,
  ) {
    // subjectId là id của REFUND (khớp topic `refunds/create` bên Sapo), nên phải kèm
    // `order_id` trong payload — không có nó thì serializer không dựng được link.
    void this.notifications.emit(NotificationTopic.refunds_create, {
      subjectType: 'order_refund',
      subjectId: refunded.refundId,
      locationId: order.locationId,
      title: `Trả hàng ${refunded.code} — hoàn ${refunded.amount.toLocaleString(
        'vi-VN',
      )}đ (đơn ${order.name})`,
      payload: {
        code: refunded.code,
        order_id: order.id.toString(),
        order_code: order.name,
        refund_amount: refunded.amount,
        deduct_from_debt: deductFromDebt,
      },
    });
  }

  /**
   * Tiền hoàn của MỌI phiếu trả + phiếu huỷ trên đơn cộng lại không được vượt giá trị
   * đơn. DTO chỉ chặn số âm, nên trước đây trả lẻ vài món vẫn hoàn được nhiều hơn cả
   * đơn — tiền ra khỏi két và công nợ khách âm mà không có gì đối chiếu lại.
   */
  private async validateRefundAmount(
    order: { id: bigint; totalPrice: Prisma.Decimal },
    refundAmount: number,
  ) {
    const agg = await this.prisma.orderRefund.aggregate({
      where: { orderId: order.id },
      _sum: { totalRefunded: true },
    });
    // Phiếu đang mở đã "giữ chỗ" phần tiền dự kiến chưa chi của nó.
    const open = await this.prisma.orderReturn.findMany({
      where: { orderId: order.id, status: OrderReturnDocStatus.in_progress },
      select: { refundAmount: true, refundedAmount: true },
    });
    const pending = open.reduce(
      (sum, r) => sum + Number(r.refundAmount) - Number(r.refundedAmount),
      0,
    );
    const already = Number(agg._sum.totalRefunded ?? 0) + pending;
    const max = Number(order.totalPrice) - already;
    if (refundAmount > max) {
      throw new BusinessException(
        'REFUND_EXCEEDS_ORDER',
        `Số tiền hoàn vượt giá trị đơn (còn hoàn được ${max}, yêu cầu ${refundAmount})`,
        422,
      );
    }
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
    // Phiếu đang mở chưa nhận hàng chưa có dòng refund nhưng đã chiếm số lượng.
    const pending = await this.prisma.orderReturnLineItem.groupBy({
      by: ['variantId', 'locationId'],
      where: {
        orderReturn: {
          orderId,
          status: OrderReturnDocStatus.in_progress,
          receivedOn: null,
        },
      },
      _sum: { quantity: true },
    });
    for (const r of pending) {
      const key = `${r.variantId}:${r.locationId}`;
      already.set(key, (already.get(key) ?? 0) + (r._sum.quantity ?? 0));
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
