import { Injectable, NotFoundException } from '@nestjs/common';
import {
  CustomerLedgerReferenceType,
  InventoryBucket,
  MovementType,
  OrderFinancialStatus,
  OrderFulfillmentStatus,
  OrderRefundStatus,
  OrderRestockStatus,
  OrderReturnStatus,
  OrderStatus,
  NotificationTopic,
  PackingStatus,
  Prisma,
  RestockType,
  ShipmentStatus,
} from '@prisma/client';
import {
  assertLocationPermission,
  locationScopeFilter,
} from '../../common/auth/access';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { findOrderIdsByQuery } from '../../common/search/unaccent-search';
import {
  appendAnd,
  firstDefined,
  parseDateRange,
  parseEnumList,
  parseIdList,
  parseIntRange,
  parseList,
} from '../../common/query/filter-params';
import {
  BusinessException,
  InsufficientStockException,
} from '../../common/exceptions/business.exception';
import { InventoryService } from '../inventory/inventory.service';
import { sortForLocking } from '../inventory/inventory.types';
import { NotificationService } from '../notifications/notification.service';
import { PriceListService } from '../pricing/price-list.service';
import { VoucherService } from '../vouchers/voucher.service';
import { CustomerDebtService } from '../customers/customer-debt.service';
import { generateOrderCode } from './order-code';
import { recomputeOrderRefundStatuses } from './order-refund-status';
import {
  calcLineTotal,
  calcOrderTotals,
  deriveTaxRate,
  PricedLine,
} from './order-pricing';
import {
  CreateOrderDto,
  ListOrdersQueryDto,
  OrderTransitionDto,
  PayOrderDto,
  ShippingAddressDto,
  UpdateOrderDto,
} from './order.dto';
import {
  OrderRepository,
  orderInclude,
  OrderWithRelations,
} from './order.repository';
import {
  serializeOrderDetail,
  serializeOrderListItem,
} from './order.serializer';

// DB xa + lặp nhiều dòng giữ chỗ/tồn — timeout mặc định 5s của Prisma quá ngắn.
const TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 };

/** Quan hệ cần nạp để `serializeOrderListItem` chạy được */
export const orderListInclude = {
  customer: true,
  location: true,
  createdBy: true,
  items: {
    select: { sku: true, variantId: true, quantity: true },
  },
  fulfillments: {
    where: { closedAt: null },
    take: 1,
    select: {
      packedStatus: true,
      shipmentStatus: true,
      provider: { select: { name: true } },
      // Đơn đồng bộ từ sàn không có provider tích hợp — tên hãng nằm ở đây
      carrierName: true,
      trackingCompany: true,
      carrier: true,
    },
  },
} as const;

function stockStatusOf(
  query: ListOrdersQueryDto,
): 'thieu_hang' | 'du_hang' | undefined {
  return query.stock_status === 'thieu_hang' || query.stock_status === 'du_hang'
    ? query.stock_status
    : undefined;
}

async function computeStockReady(
  repo: OrderRepository,
  // Location ở cấp đơn (theo Sapo), nên cặp tra tồn là (variant, location của đơn).
  orders: {
    id: bigint;
    locationId: bigint;
    items: { variantId: bigint; quantity: number }[];
  }[],
) {
  const pairs = new Map<string, { variantId: bigint; locationId: bigint }>();
  for (const row of orders) {
    for (const item of row.items) {
      pairs.set(`${item.variantId}:${row.locationId}`, {
        variantId: item.variantId,
        locationId: row.locationId,
      });
    }
  }
  const levels = pairs.size
    ? await repo.client.inventoryLevel.findMany({
        where: { OR: Array.from(pairs.values()) },
        select: { variantId: true, locationId: true, onHand: true },
      })
    : [];
  const onHandMap = new Map(
    levels.map((l) => [`${l.variantId}:${l.locationId}`, l.onHand]),
  );
  return new Map<bigint, boolean>(
    orders.map((row) => [
      row.id,
      row.items.every(
        (i) =>
          (onHandMap.get(`${i.variantId}:${row.locationId}`) ?? 0) >=
          i.quantity,
      ),
    ]),
  );
}

type ResolvedItem = {
  variantId: bigint;
  locationId: bigint;
  productName: string;
  sku: string;
  quantity: number;
  price: number;
  discount: number;
  total: number;
  /// Giá vốn chốt tại thời điểm bán — cho báo cáo lợi nhuận không trôi khi giá vốn đổi
  costPrice: Prisma.Decimal;
};

@Injectable()
export class OrderService {
  constructor(
    private repo: OrderRepository,
    private inventory: InventoryService,
    private pricing: PriceListService,
    private vouchers: VoucherService,
    private customerDebt: CustomerDebtService,
    private notifications: NotificationService,
  ) {}

  /**
   * Thông báo cho một đơn. Luôn gọi SAU khi transaction đã commit và KHÔNG await —
   * `emit` tự nuốt lỗi, nên fire-and-forget ở đây là an toàn và giữ thời gian phản hồi
   * của việc tạo/sửa đơn không phụ thuộc vào tốc độ fan-out.
   */
  private notifyOrder(
    topic: NotificationTopic,
    order: { id: bigint; name: string; locationId: bigint },
    title: string,
    payload?: Record<string, string | number | null>,
  ) {
    void this.notifications.emit(topic, {
      subjectType: 'order',
      subjectId: order.id,
      locationId: order.locationId,
      title,
      payload: { code: order.name, ...payload },
    });
  }

  /**
   * Dựng `where` cho danh sách đơn từ bộ lọc màn hình. Tách khỏi `list` để
   * export dùng lại đúng một bộ lọc — file xuất phải khớp tuyệt đối với những
   * gì người dùng đang nhìn thấy trên bảng.
   *
   * Không xử lý `stock_status`: lọc đủ/thiếu hàng phải tính tồn từng đơn bằng
   * JS nên nằm ở {@link filterByStockStatus}.
   */
  async buildListWhere(
    query: ListOrdersQueryDto,
    user: AuthUser,
  ): Promise<Prisma.OrderWhereInput> {
    const where: Prisma.OrderWhereInput = {};

    // Location nằm ở cấp đơn (theo Sapo), không còn theo từng dòng hàng.
    // `location_id` là tên cũ, chỉ nhận một kho; `location_ids` nhận nhiều.
    const locationIds = parseIdList(
      firstDefined(query.location_ids, query.location_id),
    );
    if (locationIds) {
      // Kiểm quyền từng kho: chọn nhiều kho không được phép lách phạm vi kho.
      for (const locationId of locationIds) {
        assertLocationPermission(user, 'order:view', locationId);
      }
      where.locationId = { in: locationIds };
    } else {
      where.locationId = locationScopeFilter(user, 'order:view');
    }

    const stockFilter = stockStatusOf(query);

    if (stockFilter) {
      // Đủ/thiếu hàng chỉ có ý nghĩa với đơn CÒN PHẢI XỬ LÝ. Không thể chỉ lọc
      // status='open': dữ liệu Sapo thật có 75.125 đơn 'open' nhưng 73.402 trong
      // số đó đã giao xong (Sapo không đóng đơn sau khi giao) — nạp hết sẽ vượt
      // statement_timeout. Thêm fulfillment_status IS NULL để về đúng ~1.7k đơn
      // thật sự đang chờ, khôi phục giả định "tập này luôn nhỏ" bên dưới.
      where.status = OrderStatus.open;
      where.fulfillmentStatus = null;
    } else if (query.status === 'closed') {
      // "Đã hoàn thành" thực tế = fulfillment_status='fulfilled' HOẶC
      // status='closed' — khớp guard ở order-return.service.ts, vì đa số
      // đơn đã giao thật (dữ liệu Sapo) vẫn ở status='open'.
      where.OR = [
        { status: OrderStatus.closed },
        { fulfillmentStatus: OrderFulfillmentStatus.fulfilled },
      ];
    } else if (query.status) {
      where.status = query.status as OrderStatus;
    }
    const sources = parseList(firstDefined(query.sources, query.source));
    if (sources) where.sourceName = { in: sources };

    const assignedToIds = parseIdList(
      firstDefined(query.assigned_to_ids, query.assigned_to),
    );
    if (assignedToIds) where.assignedToId = { in: assignedToIds };

    const customerIds = parseIdList(query.customer_ids);
    if (customerIds) where.customerId = { in: customerIds };

    const variantIds = parseIdList(query.variant_ids);
    if (variantIds) {
      appendAnd(where, { items: { some: { variantId: { in: variantIds } } } });
    }

    // Tag: đơn khớp MỘT tag bất kỳ trong danh sách là đủ (trước đây chỉ nhận 1 tag).
    const tags = parseList(query.tags);
    if (tags) where.tags = { hasSome: tags };

    // --- Trạng thái: mỗi vòng đời một trục, lọc độc lập và giao nhau ---
    const financialStatus = parseEnumList(
      query.financial_status,
      Object.values(OrderFinancialStatus),
    );
    if (financialStatus) where.financialStatus = { in: financialStatus };

    const returnStatus = parseEnumList(
      query.return_status,
      Object.values(OrderReturnStatus),
    );
    if (returnStatus) where.returnStatus = { in: returnStatus };

    const refundStatus = parseEnumList(
      query.refund_status,
      Object.values(OrderRefundStatus),
    );
    if (refundStatus) where.refundStatus = { in: refundStatus };

    const restockStatus = parseEnumList(
      query.restock_status,
      Object.values(OrderRestockStatus),
    );
    if (restockStatus) where.restockStatus = { in: restockStatus };

    // `unfulfilled` không phải giá trị enum — Sapo mô hình "chưa xử lý" bằng NULL.
    const fulfillmentValues = parseList(query.fulfillment_status);
    if (fulfillmentValues) {
      const enumValues =
        parseEnumList(
          query.fulfillment_status,
          Object.values(OrderFulfillmentStatus),
        ) ?? [];
      const branches: Prisma.OrderWhereInput[] = [];
      if (fulfillmentValues.includes('unfulfilled')) {
        branches.push({ fulfillmentStatus: null });
      }
      if (enumValues.length) {
        branches.push({ fulfillmentStatus: { in: enumValues } });
      }
      // Dùng appendAnd: nhánh `status=closed` ở trên đã chiếm `where.OR`.
      appendAnd(where, branches.length ? { OR: branches } : { id: { in: [] } });
    }

    // Đóng gói và giao hàng nằm trên phiếu xử lý, không nằm trên đơn.
    const packingStatus = parseEnumList(
      query.packing_status,
      Object.values(PackingStatus),
    );
    if (packingStatus) {
      appendAnd(where, {
        fulfillments: { some: { packedStatus: { in: packingStatus } } },
      });
    }

    const shipmentStatus = parseEnumList(
      query.shipment_status,
      Object.values(ShipmentStatus),
    );
    if (shipmentStatus) {
      appendAnd(where, {
        fulfillments: { some: { shipmentStatus: { in: shipmentStatus } } },
      });
    }

    const itemQuantity = parseIntRange(
      query.item_quantity_min,
      query.item_quantity_max,
    );
    if (itemQuantity) where.subtotalLineItemsQuantity = itemQuantity;

    // --- Mốc thời gian: mỗi sự kiện một trục riêng ---
    // `from`/`to` là tên cũ của cặp `created_on_min`/`created_on_max`.
    const createdOn = parseDateRange(
      firstDefined(query.created_on_min, query.from),
      firstDefined(query.created_on_max, query.to),
    );
    if (createdOn) where.createdOn = createdOn;

    const confirmedOn = parseDateRange(
      query.confirmed_on_min,
      query.confirmed_on_max,
    );
    if (confirmedOn) where.confirmedOn = confirmedOn;

    const completedOn = parseDateRange(
      query.completed_on_min,
      query.completed_on_max,
    );
    if (completedOn) where.completedOn = completedOn;

    const cancelledOn = parseDateRange(
      query.cancelled_on_min,
      query.cancelled_on_max,
    );
    if (cancelledOn) where.cancelledOn = cancelledOn;

    const paidOn = parseDateRange(query.paid_on_min, query.paid_on_max);
    if (paidOn) where.paidOn = paidOn;

    if (query.q?.trim()) {
      const ids = await findOrderIdsByQuery(this.repo.client, query.q.trim());
      where.id = { in: ids };
    }

    return where;
  }

  /**
   * Lọc đủ/thiếu hàng: không có cột lưu sẵn nên phải nạp đơn đang chờ xử lý,
   * tính tồn từng đơn rồi lọc bằng JS. Chấp nhận được vì `buildListWhere` đã
   * thu tập này về ~1.7k đơn (đơn đã giao/hủy không nằm trong tập).
   */
  async filterByStockStatus(
    where: Prisma.OrderWhereInput,
    stockFilter: 'thieu_hang' | 'du_hang',
  ): Promise<bigint[]> {
    const rows = await this.repo.client.order.findMany({
      where,
      orderBy: { createdOn: 'desc' },
      select: {
        id: true,
        locationId: true,
        items: { select: { variantId: true, quantity: true } },
      },
    });
    const readyMap = await computeStockReady(this.repo, rows);
    const wantReady = stockFilter === 'du_hang';
    return rows
      .filter((row) => (readyMap.get(row.id) ?? true) === wantReady)
      .map((row) => row.id);
  }

  async list(query: ListOrdersQueryDto, user: AuthUser) {
    const page = query.page ?? 1;
    // `limit` là tên theo Sapo Open API, `page_size` là tên cũ của dự án.
    const pageSize = query.limit ?? query.page_size ?? 20;
    const where = await this.buildListWhere(query, user);

    const stockFilter = stockStatusOf(query);

    if (stockFilter) {
      // Không có cột lưu sẵn "đủ/thiếu hàng" nên phải lấy hết đơn đang chờ
      // xử lý khớp các bộ lọc khác, tính stock_ready từng đơn rồi mới lọc +
      // phân trang bằng JS — chấp nhận được vì tập đơn ordered/processing
      // luôn nhỏ (đơn đã giao/hủy không nằm trong tập này).
      const all = await this.repo.client.order.findMany({
        where,
        orderBy: { createdOn: 'desc' },
        include: orderListInclude,
      });
      const stockReadyMap = await computeStockReady(this.repo, all);
      const wantReady = stockFilter === 'du_hang';
      const filtered = all.filter(
        (row) => (stockReadyMap.get(row.id) ?? true) === wantReady,
      );
      const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);

      return {
        data: pageRows.map((row) =>
          serializeOrderListItem(row, stockReadyMap.get(row.id) ?? true),
        ),
        total: filtered.length,
        page,
        page_size: pageSize,
      };
    }

    const [rows, total] = await Promise.all([
      this.repo.client.order.findMany({
        where,
        orderBy: { createdOn: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: orderListInclude,
      }),
      this.repo.count(where),
    ]);

    const stockReadyMap = await computeStockReady(this.repo, rows);

    return {
      data: rows.map((row) =>
        serializeOrderListItem(row, stockReadyMap.get(row.id) ?? true),
      ),
      total,
      page,
      page_size: pageSize,
    };
  }

  /**
   * Chốt quyền theo kho của đơn cho các endpoint không cần nạp cả đơn
   * (vd: lịch sử thao tác).
   */
  async assertOrderPermission(id: bigint, user: AuthUser, permission: string) {
    const order = await this.repo.client.order.findUnique({
      where: { id },
      select: { locationId: true },
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    assertLocationPermission(user, permission, order.locationId);
  }

  async findOne(id: bigint, user?: AuthUser) {
    const order = await this.repo.findById(id);
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    if (user) {
      assertLocationPermission(user, 'order:view', order.locationId);
    }

    const detail = serializeOrderDetail(order);
    const [levels, customerStats] = await Promise.all([
      this.repo.client.inventoryLevel.findMany({
        where: {
          locationId: order.locationId,
          variantId: { in: order.items.map((i) => i.variantId) },
        },
      }),
      order.customerId
        ? Promise.all([
            this.repo.client.order.aggregate({
              where: { customerId: order.customerId },
              _count: { _all: true },
              _sum: { totalPrice: true },
            }),
            this.repo.client.order.findFirst({
              where: { customerId: order.customerId },
              orderBy: { createdOn: 'desc' },
              select: { id: true, name: true },
            }),
          ]).then(([agg, last]) => ({
            total_orders: agg._count._all,
            total_spent: Number(agg._sum.totalPrice ?? 0),
            last_order_id: last?.id.toString() ?? null,
            last_order_code: last?.name ?? null,
          }))
        : Promise.resolve(null),
    ]);
    const availMap = new Map(
      levels.map((l) => [`${l.variantId}:${l.locationId}`, l.available]),
    );
    const onHandMap = new Map(
      levels.map((l) => [`${l.variantId}:${l.locationId}`, l.onHand]),
    );
    const stockShortageItems = detail.items
      .map((i) => ({
        sku: i.sku,
        required: i.quantity,
        on_hand: onHandMap.get(`${i.variant_id}:${order.locationId}`) ?? 0,
      }))
      .filter((i) => i.on_hand < i.required);

    return {
      data: {
        ...detail,
        stock_ready: stockShortageItems.length === 0,
        stock_shortage_items: stockShortageItems,
        items: detail.items.map((i) => ({
          ...i,
          available: availMap.get(`${i.variant_id}:${order.locationId}`) ?? 0,
        })),
        customer:
          detail.customer && customerStats
            ? { ...detail.customer, ...customerStats }
            : detail.customer,
      },
    };
  }

  async update(id: bigint, dto: UpdateOrderDto, user: AuthUser) {
    const order = await this.repo.findById(id);
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    assertLocationPermission(user, 'order:update', order.locationId);
    if (order.status !== OrderStatus.open || order.confirmedOn !== null) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Chỉ sửa đơn khi chưa xác nhận',
        409,
      );
    }

    const totalDiscounts =
      dto.total_discounts !== undefined
        ? dto.total_discounts
        : Number(order.totalDiscounts);
    const totalShippingPrice =
      dto.total_shipping_price !== undefined
        ? dto.total_shipping_price
        : Number(order.totalShippingPrice);

    const pricedLines: PricedLine[] = order.items.map((i) => ({
      quantity: i.quantity,
      price: Number(i.price),
      discount: Number(i.totalDiscount),
    }));
    const subTotalPrice = pricedLines.reduce((s, l) => s + calcLineTotal(l), 0);
    const taxRate =
      dto.tax_rate !== undefined
        ? dto.tax_rate
        : deriveTaxRate(subTotalPrice, totalDiscounts, Number(order.totalTax));
    const totals = calcOrderTotals(
      pricedLines,
      totalDiscounts,
      totalShippingPrice,
      taxRate,
    );

    const totalReceived = Number(order.totalReceived);
    if (totals.totalPrice < totalReceived) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Giá trị đơn sau sửa nhỏ hơn số tiền khách đã thanh toán',
        422,
      );
    }

    const data: Prisma.OrderUpdateInput = {
      totalDiscounts,
      totalShippingPrice,
      subTotalPrice: totals.subTotalPrice,
      totalTax: totals.totalTax,
      totalPrice: totals.totalPrice,
      subtotalLineItemsQuantity: totals.subtotalLineItemsQuantity,
      financialStatus:
        totalReceived >= totals.totalPrice
          ? OrderFinancialStatus.paid
          : totalReceived > 0
            ? OrderFinancialStatus.partially_paid
            : OrderFinancialStatus.pending,
    };
    if (dto.note !== undefined) data.note = dto.note.trim() || null;
    if (dto.tags !== undefined) data.tags = dto.tags;
    if (dto.assigned_to !== undefined) {
      data.assignedTo = { connect: { id: BigInt(dto.assigned_to) } };
    }
    if (dto.expected_delivery_date !== undefined) {
      data.expectedDeliveryDate = dto.expected_delivery_date
        ? new Date(dto.expected_delivery_date)
        : null;
    }
    if (dto.shipping_method !== undefined) {
      data.shippingMethod = dto.shipping_method.trim() || null;
    }

    const totalDelta = totals.totalPrice - Number(order.totalPrice);

    const updated = await this.repo.client.$transaction(async (tx) => {
      // Sửa đơn làm đổi giá trị → điều chỉnh nợ phải thu theo chênh lệch
      if (order.customerId && totalDelta !== 0) {
        await this.customerDebt.recordEntry(
          {
            customerId: order.customerId,
            referenceType: CustomerLedgerReferenceType.adjustment,
            referenceCode: order.name,
            transactionLabel: 'Sửa đơn hàng',
            reason: `Cập nhật giá trị đơn ${order.name}`,
            amount: totalDelta,
            createdById: user.userId,
          },
          tx,
        );
      }

      const record = await tx.order.update({
        where: { id },
        data,
        include: orderInclude,
      });

      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'order.update',
          entityType: 'order',
          entityId: id,
          metadata: { code: order.name },
        },
      });

      return record;
    });

    return { data: serializeOrderDetail(updated) };
  }

  /** Thanh toán đơn (toàn bộ hoặc một phần) — phiếu thu + giảm công nợ KH */
  async pay(id: bigint, dto: PayOrderDto, user: AuthUser) {
    const order = await this.repo.findById(id);
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    assertLocationPermission(user, 'order:update', order.locationId);

    if (order.status === OrderStatus.cancelled) {
      throw new BusinessException(
        'INVALID_TRANSITION',
        'Không thể thanh toán đơn đã hủy',
        409,
      );
    }
    if (order.financialStatus === OrderFinancialStatus.paid) {
      return {
        id: order.id.toString(),
        payment_status: OrderFinancialStatus.paid,
        paid_amount: order.totalReceived.toString(),
      };
    }

    const remaining = Number(order.totalPrice) - Number(order.totalReceived);
    const payAmount = dto.amount ?? remaining;

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
        `Số tiền thanh toán vượt quá số còn phải thu (còn ${remaining})`,
        422,
      );
    }

    const newPaidAmount = Number(order.totalReceived) + payAmount;
    const reachedPaid = newPaidAmount >= Number(order.totalPrice);
    const newStatus = reachedPaid
      ? OrderFinancialStatus.paid
      : OrderFinancialStatus.partially_paid;

    const voucher = await this.repo.client.$transaction(async (tx) => {
      await tx.order.update({
        where: { id },
        data: {
          financialStatus: newStatus,
          totalReceived: newPaidAmount,
          ...(reachedPaid ? { paidOn: new Date() } : {}),
        },
      });

      const result = await this.vouchers.createReceipt(
        {
          locationId: order.locationId,
          amount: payAmount,
          createdById: user.userId,
          sourceDocument: order.name,
          referenceType: 'order',
          referenceId: order.id,
          reason: `Thanh toán đơn ${order.name}`,
        },
        tx,
      );

      if (order.customerId) {
        await this.customerDebt.recordEntry(
          {
            customerId: order.customerId,
            referenceType: CustomerLedgerReferenceType.payment,
            referenceCode: order.name,
            transactionLabel: 'Thanh toán',
            reason: `Thanh toán đơn ${order.name}`,
            amount: -payAmount,
            createdById: user.userId,
          },
          tx,
        );
      }

      await tx.activityLog.create({
        data: {
          userId: user.userId,
          action: 'order.pay',
          entityType: 'order',
          entityId: id,
          metadata: { code: order.name, amount: payAmount },
        },
      });

      return result;
    });

    // Chỉ báo khi đơn đã thu ĐỦ. Thanh toán từng phần là chuyện thường ngày của đơn
    // công nợ — báo mỗi lần trả góp sẽ biến chuông thành nhiễu.
    if (reachedPaid) {
      this.notifyOrder(
        NotificationTopic.orders_paid,
        order,
        `Đơn ${order.name} đã thanh toán đủ`,
        { total_price: Number(order.totalPrice), amount: payAmount },
      );
    }

    return {
      id: order.id.toString(),
      payment_status: newStatus,
      paid_amount: newPaidAmount.toString(),
      voucher,
    };
  }

  async create(dto: CreateOrderDto, user: AuthUser) {
    if (!dto.items?.length) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Đơn phải có ít nhất một dòng',
        422,
      );
    }

    for (const item of dto.items) {
      if (!item.location_id) {
        throw new BusinessException(
          'MISSING_WAREHOUSE',
          'Mỗi dòng hàng phải có kho xuất',
          422,
        );
      }
    }

    const locationId = BigInt(dto.location_id);
    assertLocationPermission(user, 'order:create', locationId);
    await this.repo.client.location.findUniqueOrThrow({
      where: { id: locationId },
    });

    if (dto.name) {
      const dup = await this.repo.findByCode(dto.name.trim());
      if (dup) {
        throw new BusinessException('DUPLICATE_CODE', 'Mã đơn đã tồn tại', 409);
      }
    }

    const resolvedItems = await this.resolveItems(dto);
    const pricedLines: PricedLine[] = resolvedItems.map((i) => ({
      quantity: i.quantity,
      price: i.price,
      discount: i.discount,
    }));
    const totals = calcOrderTotals(
      pricedLines,
      dto.total_discounts ?? 0,
      dto.total_shipping_price ?? 0,
      dto.tax_rate ?? 0,
    );

    if (!dto.customer_id?.trim()) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Phải chọn khách hàng',
        422,
      );
    }

    const customerId = BigInt(dto.customer_id.trim());
    const shippingAddress = await this.resolveShippingAddress(
      customerId,
      dto.shipping_address,
    );
    const assignedToId = dto.assigned_to
      ? BigInt(dto.assigned_to)
      : user.userId;

    const initialPaid = dto.total_received ?? 0;
    if (initialPaid > totals.totalPrice) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Số tiền thanh toán vượt quá giá trị đơn',
        422,
      );
    }

    try {
      const order = await this.repo.client.$transaction(async (tx) => {
        const name =
          dto.name?.trim() || (await generateOrderCode(tx, locationId));

        const initialPaidReachesFull =
          initialPaid >= totals.totalPrice && totals.totalPrice > 0;
        const record = await tx.order.create({
          data: {
            name,
            locationId,
            customerId,
            sourceName: dto.source_name?.trim() || null,
            status: OrderStatus.open,
            assignedToId,
            createdById: user.userId,
            email: dto.email?.trim() || null,
            phone: dto.phone?.trim() || null,
            subTotalPrice: totals.subTotalPrice,
            totalDiscounts: dto.total_discounts ?? 0,
            totalTax: totals.totalTax,
            totalShippingPrice: dto.total_shipping_price ?? 0,
            shippingMethod: dto.shipping_method?.trim() || null,
            totalPrice: totals.totalPrice,
            subtotalLineItemsQuantity: totals.subtotalLineItemsQuantity,
            totalReceived: initialPaid,
            financialStatus: initialPaidReachesFull
              ? OrderFinancialStatus.paid
              : initialPaid > 0
                ? OrderFinancialStatus.partially_paid
                : OrderFinancialStatus.pending,
            ...(initialPaidReachesFull ? { paidOn: new Date() } : {}),
            note: dto.note?.trim() || null,
            tags: dto.tags ?? [],
            createdOn: dto.created_on ? new Date(dto.created_on) : new Date(),
            expectedDeliveryDate: dto.expected_delivery_date
              ? new Date(dto.expected_delivery_date)
              : null,
            deliveryMode: dto.delivery_mode ?? undefined,
            shippingName: shippingAddress.name?.trim() || null,
            shippingFirstName: shippingAddress.first_name?.trim() || null,
            shippingLastName: shippingAddress.last_name?.trim() || null,
            shippingPhone: shippingAddress.phone?.trim() || null,
            shippingAddress1: shippingAddress.address1?.trim() || null,
            shippingAddress2: shippingAddress.address2?.trim() || null,
            shippingWard: shippingAddress.ward?.trim() || null,
            shippingWardCode: shippingAddress.ward_code?.trim() || null,
            shippingDistrict: shippingAddress.district?.trim() || null,
            shippingDistrictCode: shippingAddress.district_code?.trim() || null,
            shippingProvince: shippingAddress.province?.trim() || null,
            shippingProvinceCode: shippingAddress.province_code?.trim() || null,
            shippingCity: shippingAddress.city?.trim() || null,
            shippingCountry: shippingAddress.country?.trim() || null,
            shippingCountryCode: shippingAddress.country_code?.trim() || null,
            shippingZip: shippingAddress.zip?.trim() || null,
            shippingCompany: shippingAddress.company?.trim() || null,
            deliveryCodAmount: dto.delivery_cod_amount ?? null,
            deliveryWeightGrams: dto.delivery_weight_grams ?? null,
            deliveryLengthCm: dto.delivery_length_cm ?? null,
            deliveryWidthCm: dto.delivery_width_cm ?? null,
            deliveryHeightCm: dto.delivery_height_cm ?? null,
            deliveryRequirement: dto.delivery_requirement?.trim() || null,
            deliveryNote: dto.delivery_note?.trim() || null,
            invoiceTaxCode: dto.invoice_tax_code?.trim() || null,
            invoiceCompanyName: dto.invoice_company_name?.trim() || null,
            invoiceAddress: dto.invoice_address?.trim() || null,
            invoiceBuyerName: dto.invoice_buyer_name?.trim() || null,
            invoiceIdCard: dto.invoice_id_card?.trim() || null,
            invoiceBudgetCode: dto.invoice_budget_code?.trim() || null,
            invoicePhone: dto.invoice_phone?.trim() || null,
            invoiceEmail: dto.invoice_email?.trim() || null,
            invoiceSellToConsumer: dto.invoice_sell_to_consumer ?? false,
            // location không còn theo từng dòng hàng — order_items không có
            // cột location_id (bỏ ở Phase 1, Sapo đặt location ở cấp đơn).
            items: {
              create: resolvedItems.map((i) => ({
                variantId: i.variantId,
                name: i.productName,
                sku: i.sku,
                quantity: i.quantity,
                price: i.price,
                totalDiscount: i.discount,
                discountedTotal: i.total,
                originalTotal: i.quantity * i.price,
                costPrice: i.costPrice,
              })),
            },
          },
        });

        for (const item of sortForLocking(resolvedItems)) {
          assertLocationPermission(user, 'order:create', item.locationId);
          await this.inventory.applyMovement(
            {
              variantId: item.variantId,
              locationId,
              bucket: InventoryBucket.committed,
              change: item.quantity,
              type: MovementType.order_reserve,
              referenceType: 'order',
              referenceId: record.id,
              createdById: user.userId,
            },
            tx,
          );
        }

        // Công nợ KH: khách mua chưa thanh toán → tăng nợ phải thu
        if (customerId) {
          await this.customerDebt.recordEntry(
            {
              customerId,
              referenceType: CustomerLedgerReferenceType.order,
              referenceCode: record.name,
              transactionLabel: 'Bán hàng',
              reason: `Đơn hàng ${record.name}`,
              amount: totals.totalPrice,
              createdById: user.userId,
            },
            tx,
          );
        }

        if (initialPaid > 0) {
          await this.vouchers.createReceipt(
            {
              locationId,
              amount: initialPaid,
              createdById: user.userId,
              sourceDocument: record.name,
              referenceType: 'order',
              referenceId: record.id,
              reason: `Thanh toán đơn ${record.name}`,
            },
            tx,
          );
          if (customerId) {
            await this.customerDebt.recordEntry(
              {
                customerId,
                referenceType: CustomerLedgerReferenceType.payment,
                referenceCode: record.name,
                transactionLabel: 'Thanh toán',
                reason: `Thanh toán khi tạo đơn ${record.name}`,
                amount: -initialPaid,
                createdById: user.userId,
              },
              tx,
            );
          }
        }

        await tx.activityLog.create({
          data: {
            userId: user.userId,
            action: 'order.create',
            entityType: 'order',
            entityId: record.id,
            metadata: { code: record.name, status: record.status },
          },
        });

        return record;
      }, TX_OPTIONS);

      // Sau khi tx commit — không đưa vào trong tx: fan-out chậm sẽ giữ lock hàng đơn,
      // và tx rollback vẫn để lại thông báo trỏ tới đơn không tồn tại.
      this.notifyOrder(
        NotificationTopic.orders_create,
        order,
        `Đơn hàng mới ${order.name}`,
        {
          total_price: Number(order.totalPrice),
          source_name: order.sourceName,
        },
      );
      // Đơn tạo ra đã thanh toán đủ luôn (bán tại quầy) thì không đi qua nhánh
      // `pay()` bên dưới, nên phải bắn orders/paid ngay tại đây.
      if (order.financialStatus === OrderFinancialStatus.paid) {
        this.notifyOrder(
          NotificationTopic.orders_paid,
          order,
          `Đơn ${order.name} đã thanh toán đủ`,
          { total_price: Number(order.totalPrice) },
        );
      }

      return {
        id: order.id.toString(),
        code: order.name,
        status: order.status,
      };
    } catch (e) {
      if (e instanceof InsufficientStockException) throw e;
      throw e;
    }
  }

  /** Đơn có fulfillment đang mở thì trạng thái do vận đơn điều khiển —
   * chặn các action thủ công ship/complete/cancel. */
  private async assertNoOpenFulfillment(orderId: bigint, message: string) {
    const open = await this.repo.client.fulfillment.findFirst({
      where: { orderId, closedAt: null },
      select: { id: true },
    });
    if (open) {
      throw new BusinessException('INVALID_TRANSITION', message, 409);
    }
  }

  /** Trừ on_hand + committed cho toàn bộ dòng hàng — dùng ở cả action 'ship'
   * và action 'complete' (khi đơn hoàn thành thẳng mà chưa qua bước xuất hàng). */
  private async shipOrderItems(
    order: OrderWithRelations,
    user: AuthUser,
    tx: Prisma.TransactionClient,
  ) {
    for (const item of sortForLocking(order.items)) {
      await this.inventory.applyMovements(
        [
          {
            variantId: item.variantId,
            locationId: order.locationId,
            bucket: InventoryBucket.on_hand,
            change: -item.quantity,
            type: MovementType.order_ship,
            referenceType: 'order',
            referenceId: order.id,
            createdById: user.userId,
          },
          {
            variantId: item.variantId,
            locationId: order.locationId,
            bucket: InventoryBucket.committed,
            change: -item.quantity,
            type: MovementType.order_ship,
            referenceType: 'order',
            referenceId: order.id,
            createdById: user.userId,
          },
        ],
        tx,
      );
    }
  }

  async transition(id: bigint, dto: OrderTransitionDto, user: AuthUser) {
    const order = await this.repo.findById(id);
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    const action = dto.action;
    // Mỗi hành động chuyển trạng thái đòi một quyền riêng — controller chỉ kiểm
    // "có MỘT trong ba", nên phải chốt lại đúng quyền tại kho của đơn.
    const permissionByAction = {
      cancel: 'order:cancel',
      ship: 'order:pack',
      processing: 'order:update',
      complete: 'order:update',
    } as const;
    assertLocationPermission(
      user,
      permissionByAction[action] ?? 'order:update',
      order.locationId,
    );

    // "ordered" cũ = status open & chưa xác nhận; "processing" cũ = status
    // open & đã xác nhận (confirmedOn khác null). Theo Sapo, status tự nó chỉ
    // có open/closed/cancelled — mức độ chi tiết hơn nằm ở các mốc thời gian.
    const isOrderedEquivalent =
      order.status === OrderStatus.open && order.confirmedOn === null;
    const isProcessingEquivalent =
      order.status === OrderStatus.open && order.confirmedOn !== null;

    if (action === 'processing') {
      if (!isOrderedEquivalent) {
        throw new BusinessException(
          'INVALID_TRANSITION',
          'Chỉ xác nhận đơn khi đang ở trạng thái chờ xác nhận',
          409,
        );
      }
      await this.repo.client.$transaction(async (tx) => {
        await tx.order.update({
          where: { id },
          data: { confirmedOn: new Date() },
        });
        await tx.activityLog.create({
          data: {
            userId: user.userId,
            action: 'order.transition_processing',
            entityType: 'order',
            entityId: id,
            metadata: { code: order.name },
          },
        });
      });
      return { id: id.toString(), status: OrderStatus.open };
    }

    if (action === 'cancel') {
      if (!isOrderedEquivalent && !isProcessingEquivalent) {
        throw new BusinessException(
          'INVALID_TRANSITION',
          'Không thể hủy đơn ở trạng thái này',
          409,
        );
      }
      await this.assertNoOpenFulfillment(
        id,
        'Hủy vận đơn trước khi hủy đơn hàng',
      );
      if (order.deliveredOn) {
        throw new BusinessException(
          'INVALID_TRANSITION',
          'Đơn đã xuất hàng, không thể hủy — dùng đổi trả hàng',
          409,
        );
      }
      await this.repo.client.$transaction(async (tx) => {
        for (const item of sortForLocking(order.items)) {
          await this.inventory.applyMovement(
            {
              variantId: item.variantId,
              locationId: order.locationId,
              bucket: InventoryBucket.committed,
              change: -item.quantity,
              type: MovementType.order_release,
              referenceType: 'order',
              referenceId: order.id,
              createdById: user.userId,
            },
            tx,
          );
        }
        // Hủy đơn giảm công nợ đúng giá trị đơn; phần khách đã trả
        // trở thành nợ âm (shop nợ khách) chờ hoàn tiền
        if (order.customerId) {
          await this.customerDebt.recordEntry(
            {
              customerId: order.customerId,
              referenceType: CustomerLedgerReferenceType.order,
              referenceCode: order.name,
              transactionLabel: 'Hủy đơn',
              reason: `Hủy đơn hàng ${order.name}`,
              amount: -Number(order.totalPrice),
              createdById: user.userId,
            },
            tx,
          );
        }

        // Sapo ghi nhận việc huỷ bằng một bản ghi `refund` không gắn phiếu trả
        // hàng (`return_id` = null), các dòng mang `restock_type = cancel` —
        // hàng chưa từng rời kho nên không tính là khách trả về.
        // `total_refunded` = số khách đã trả: huỷ đơn chưa thu tiền thì bằng 0,
        // đúng như Sapo (đơn huỷ chưa thu vẫn giữ financial_status cũ).
        const refundedAmount = Number(order.totalReceived);
        await tx.orderRefund.create({
          data: {
            orderId: id,
            returnId: null,
            note: dto.reason?.trim() || `Hủy đơn hàng ${order.name}`,
            restock: false,
            totalRefunded: refundedAmount,
            createdById: user.userId,
            lineItems: {
              create: order.items.map((i) => ({
                orderItemId: i.id,
                variantId: i.variantId,
                locationId: order.locationId,
                productName: i.name,
                sku: i.sku,
                variantTitle: i.variantTitle,
                quantity: i.quantity,
                price: i.price,
                subtotal: Number(i.price) * i.quantity,
                restockType: RestockType.cancel,
              })),
            },
          },
        });

        await tx.order.update({
          where: { id },
          data: {
            status: OrderStatus.cancelled,
            cancelledOn: new Date(),
            cancelReason: dto.reason?.trim() || null,
          },
        });

        // Đặt lại financial/refund/restock_status từ toàn bộ refund của đơn
        await recomputeOrderRefundStatuses(tx, id);
        if (refundedAmount > 0) {
          await tx.order.update({
            where: { id },
            data: {
              financialStatus:
                refundedAmount >= Number(order.totalPrice)
                  ? OrderFinancialStatus.refunded
                  : OrderFinancialStatus.partially_refunded,
            },
          });
        }
        await tx.activityLog.create({
          data: {
            userId: user.userId,
            action: 'order.cancel',
            entityType: 'order',
            entityId: id,
            metadata: { code: order.name },
          },
        });
      }, TX_OPTIONS);
      this.notifyOrder(
        NotificationTopic.orders_cancelled,
        order,
        `Đơn ${order.name} đã bị hủy`,
        { reason: dto.reason?.trim() || null },
      );
      return { id: id.toString(), status: OrderStatus.cancelled };
    }

    if (action === 'ship') {
      if (!isProcessingEquivalent) {
        throw new BusinessException(
          'INVALID_TRANSITION',
          'Chỉ xuất hàng sau khi đã xác nhận đơn',
          409,
        );
      }
      await this.assertNoOpenFulfillment(
        id,
        'Đơn đang xử lý qua vận đơn — cập nhật trạng thái trên vận đơn',
      );
      if (order.deliveredOn) {
        throw new BusinessException(
          'INVALID_TRANSITION',
          'Đơn đã xuất hàng',
          409,
        );
      }
      const deliveredOn = await this.repo.client.$transaction(async (tx) => {
        await this.shipOrderItems(order, user, tx);
        const now = new Date();
        await tx.order.update({
          where: { id },
          data: {
            deliveredOn: now,
            fulfillmentStatus: OrderFulfillmentStatus.fulfilled,
          },
        });
        await tx.activityLog.create({
          data: {
            userId: user.userId,
            action: 'order.ship',
            entityType: 'order',
            entityId: id,
            metadata: { code: order.name },
          },
        });
        return now;
      }, TX_OPTIONS);
      this.notifyOrder(
        NotificationTopic.orders_fulfilled,
        order,
        `Đơn ${order.name} đã xuất hàng`,
      );
      return {
        id: id.toString(),
        status: order.status,
        shipped_at: deliveredOn.toISOString(),
      };
    }

    if (action === 'complete') {
      if (!isProcessingEquivalent) {
        throw new BusinessException(
          'INVALID_TRANSITION',
          'Chỉ hoàn thành sau khi đã xác nhận đơn',
          409,
        );
      }
      await this.assertNoOpenFulfillment(
        id,
        'Đơn đang xử lý qua vận đơn — cập nhật trạng thái trên vận đơn',
      );
      await this.repo.client.$transaction(async (tx) => {
        // Đơn có thể đã xuất hàng trước đó qua action 'ship' — chỉ xuất
        // kho ở đây nếu chưa từng xuất, tránh trừ tồn kho hai lần.
        if (!order.deliveredOn) {
          await this.shipOrderItems(order, user, tx);
        }
        const now = new Date();
        await tx.order.update({
          where: { id },
          data: {
            status: OrderStatus.closed,
            closedOn: now,
            completedOn: now,
            fulfillmentStatus: OrderFulfillmentStatus.fulfilled,
            deliveredOn: order.deliveredOn ?? now,
          },
        });
        await tx.activityLog.create({
          data: {
            userId: user.userId,
            action: 'order.complete',
            entityType: 'order',
            entityId: id,
            metadata: { code: order.name },
          },
        });
      }, TX_OPTIONS);
      // `complete` cũng đặt fulfillment_status = fulfilled. Chỉ báo nếu đơn CHƯA từng
      // xuất hàng qua action 'ship' — nếu không thì cùng một đơn bắn orders/fulfilled
      // hai lần (ship rồi complete là luồng bình thường).
      if (!order.deliveredOn) {
        this.notifyOrder(
          NotificationTopic.orders_fulfilled,
          order,
          `Đơn ${order.name} đã hoàn thành`,
        );
      }
      return { id: id.toString(), status: OrderStatus.closed };
    }

    throw new BusinessException('VALIDATION_ERROR', 'Action không hợp lệ', 422);
  }

  /** Dùng chung cho draft convert & channel webhook */
  async createFromResolvedItems(
    params: {
      locationId: bigint;
      sourceName?: string;
      customerId: bigint;
      items: ResolvedItem[];
      totalDiscounts?: number;
      totalShippingPrice?: number;
      note?: string;
      phone?: string;
      name?: string;
      createdOn?: Date;
      shippingAddress?: ShippingAddressDto;
      totalReceived?: number;
      deliveryCodAmount?: number;
      shippingMethod?: string;
    },
    user: AuthUser,
  ) {
    const dto: CreateOrderDto = {
      location_id: params.locationId.toString(),
      source_name: params.sourceName,
      customer_id: params.customerId.toString(),
      items: params.items.map((i) => ({
        variant_id: i.variantId.toString(),
        location_id: i.locationId.toString(),
        quantity: i.quantity,
        price: i.price,
        discount: i.discount,
      })),
      total_discounts: params.totalDiscounts,
      total_shipping_price: params.totalShippingPrice,
      note: params.note,
      phone: params.phone,
      ...(params.name ? { name: params.name } : {}),
      ...(params.createdOn
        ? { created_on: params.createdOn.toISOString() }
        : {}),
      ...(params.shippingAddress
        ? { shipping_address: params.shippingAddress }
        : {}),
      ...(params.totalReceived != null
        ? { total_received: params.totalReceived }
        : {}),
      ...(params.deliveryCodAmount != null
        ? { delivery_cod_amount: params.deliveryCodAmount }
        : {}),
      ...(params.shippingMethod
        ? { shipping_method: params.shippingMethod }
        : {}),
    };
    return this.create(dto, user);
  }

  private async resolveItems(dto: CreateOrderDto): Promise<ResolvedItem[]> {
    const result: ResolvedItem[] = [];
    for (const item of dto.items) {
      const variantId = BigInt(item.variant_id);
      const locationId = BigInt(item.location_id);
      const variant = await this.repo.client.productVariant.findUnique({
        where: { id: variantId },
        include: { product: true },
      });
      if (!variant) {
        throw new BusinessException(
          'VALIDATION_ERROR',
          `Không tìm thấy phiên bản ${item.variant_id}`,
          422,
        );
      }

      let price = item.price;
      if (price === undefined) {
        const resolved = await this.pricing.resolvePrice(variantId, {
          location_id: locationId,
        });
        price = resolved.price;
      }

      const discount = item.discount ?? 0;
      result.push({
        variantId,
        locationId,
        productName: variant.product.name,
        sku: variant.sku,
        quantity: item.quantity,
        price,
        discount,
        total: calcLineTotal({ quantity: item.quantity, price, discount }),
        costPrice: variant.cost,
      });
    }
    return result;
  }

  private shippingAddressComplete(sa?: ShippingAddressDto | null) {
    return !!(
      sa?.address1?.trim() &&
      sa?.ward?.trim() &&
      sa?.district?.trim() &&
      sa?.province?.trim()
    );
  }

  /** Ưu tiên địa chỉ gửi lên; thiếu thì lấy địa chỉ mặc định của khách. */
  private async resolveShippingAddress(
    customerId: bigint,
    fromDto?: ShippingAddressDto,
  ): Promise<ShippingAddressDto> {
    const dto = fromDto ?? {};
    if (this.shippingAddressComplete(dto)) return dto;

    const customer = await this.repo.client.customer.findUnique({
      where: { id: customerId },
      include: {
        addresses: { orderBy: [{ isDefault: 'desc' }, { id: 'asc' }] },
      },
    });
    if (!customer) return dto;

    const addr =
      customer.addresses.find((a) => a.isDefault) ?? customer.addresses[0];
    const name =
      dto.name?.trim() ||
      (addr ? [addr.firstName, addr.lastName].filter(Boolean).join(' ') : '') ||
      [customer.firstName, customer.lastName].filter(Boolean).join(' ');
    const phone =
      dto.phone?.trim() ||
      addr?.phone?.trim() ||
      customer.phone?.trim() ||
      undefined;

    if (!addr) {
      return { ...dto, name: name || undefined, phone };
    }

    return {
      name: name || undefined,
      first_name: dto.first_name || addr.firstName || undefined,
      last_name: dto.last_name || addr.lastName || undefined,
      phone,
      address1: dto.address1?.trim() || addr.address1 || undefined,
      address2: dto.address2?.trim() || addr.address2 || undefined,
      ward: dto.ward?.trim() || addr.ward || undefined,
      ward_code: dto.ward_code?.trim() || addr.wardCode || undefined,
      district: dto.district?.trim() || addr.district || undefined,
      district_code:
        dto.district_code?.trim() || addr.districtCode || undefined,
      province: dto.province?.trim() || addr.province || undefined,
      province_code:
        dto.province_code?.trim() || addr.provinceCode || undefined,
      city: dto.city?.trim() || addr.city || undefined,
      country: dto.country?.trim() || addr.country || undefined,
      country_code: dto.country_code?.trim() || addr.countryCode || undefined,
      zip: dto.zip?.trim() || addr.zip || undefined,
      company: dto.company?.trim() || addr.company || undefined,
    };
  }
}

export type { ResolvedItem };
