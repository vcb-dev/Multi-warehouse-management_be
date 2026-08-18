import { Injectable, Logger } from '@nestjs/common';
import {
  ChannelConnection,
  FulfillmentDeliveryMethod,
  OrderFinancialStatus,
  OrderFulfillmentStatus,
  OrderSource,
  OrderStatus,
  PackingStatus,
  Prisma,
  ShipmentStatus,
} from '@prisma/client';
import { BusinessException } from '../../../common/exceptions/business.exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { ShopeeAuthService } from './shopee-auth.service';
import {
  ShopeeClient,
  ShopeeOrderDetail,
  ShopeeOrderItem,
} from './shopee.client';

/** Shopee `get_order_list` lọc theo `order_status` — phải gọi mỗi trạng thái. */
const SYNC_STATUSES = [
  'UNPAID',
  'READY_TO_SHIP',
  'PROCESSED',
  'SHIPPED',
  'COMPLETED',
  'CANCELLED',
  'IN_CANCEL',
] as const;

type SyncOrderResult = {
  order_sn: string;
  order_id?: string;
  created?: boolean;
  updated?: boolean;
  skipped_lines?: number;
  error?: string;
};

type VariantRef = {
  id: bigint;
  sku: string;
  productId: bigint;
  cost: Prisma.Decimal;
};

type SkuGap = {
  sku: string;
  productName: string | null;
  variantName: string | null;
  lineCount: number;
  quantity: number;
  amount: Prisma.Decimal;
  lastSeenAt: Date;
};

type LineUnit = {
  sku: string;
  productName: string | null;
  variantTitle: string | null;
  quantity: number;
  originalPrice: Prisma.Decimal;
  salePrice: Prisma.Decimal;
};

/**
 * Kéo đơn Shopee Open API vào `orders` qua Prisma upsert — không qua `OrderService`.
 * Cùng quy ước TikTok: upsert theo `orders.name` (= order_sn), không đụng tồn kho,
 * SKU lạ bỏ dòng + ghi `channel_sku_gaps`.
 */
@Injectable()
export class ShopeeSyncService {
  private readonly logger = new Logger(ShopeeSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopeeAuth: ShopeeAuthService,
  ) {}

  async syncShopeeOrders(
    createdById: bigint,
    connectionId?: string,
  ): Promise<{
    fetched: number;
    created: number;
    updated: number;
    skipped_lines: number;
    unmatched_skus: number;
    results: SyncOrderResult[];
  }> {
    const client = this.shopeeAuth.getClient();
    const connections = await this.loadConnections(connectionId);
    const timeTo = Math.floor(Date.now() / 1000);
    const timeFrom = timeTo - this.syncWindowDays() * 24 * 60 * 60;
    return this.syncConnectionsInWindow(
      client,
      connections,
      createdById,
      timeFrom,
      timeTo,
    );
  }

  /** Quét cửa sổ ngắn theo `update_time` — dành cho cron. */
  async syncRecent(windowMinutes: number, createdById: bigint) {
    const client = this.shopeeAuth.getClient();
    const connections = await this.loadConnections();
    const timeTo = Math.floor(Date.now() / 1000);
    const timeFrom = timeTo - windowMinutes * 60;
    const result = await this.syncConnectionsInWindow(
      client,
      connections,
      createdById,
      timeFrom,
      timeTo,
    );
    return { window_minutes: windowMinutes, ...result };
  }

  /** Kéo đúng vài đơn theo order_sn — dành cho webhook push. */
  async syncOrderSns(orderSns: string[], shopId: string, createdById: bigint) {
    if (!orderSns.length) {
      return {
        fetched: 0,
        created: 0,
        updated: 0,
        skipped_lines: 0,
        unmatched_skus: 0,
        results: [] as SyncOrderResult[],
      };
    }

    const conn = await this.prisma.channelConnection.findFirst({
      where: { channel: OrderSource.shopee, shopId },
    });
    if (!conn) {
      this.logger.warn(`Webhook Shopee: shop ${shopId} chưa kết nối`);
      return {
        fetched: 0,
        created: 0,
        updated: 0,
        skipped_lines: 0,
        unmatched_skus: 0,
        results: [] as SyncOrderResult[],
      };
    }

    const client = this.shopeeAuth.getClient();
    const locationId = await this.resolveLocationId(conn);
    const fresh = await this.shopeeAuth.ensureFreshConnection(conn.id);
    const detail = await client.getOrderDetail(
      fresh.accessToken,
      fresh.shopId,
      orderSns,
    );

    const orders = detail.order_list ?? [];
    const result = await this.applyOrders(
      orders,
      locationId,
      createdById,
      fresh.shopId,
    );
    return result;
  }

  private async syncConnectionsInWindow(
    client: ShopeeClient,
    connections: ChannelConnection[],
    createdById: bigint,
    timeFrom: number,
    timeTo: number,
  ) {
    const allResults: SyncOrderResult[] = [];
    let fetched = 0;
    let created = 0;
    let updated = 0;
    let skippedLines = 0;
    let unmatchedSkus = 0;

    for (const conn of connections) {
      const connResult = await this.syncConnection(
        client,
        conn,
        createdById,
        timeFrom,
        timeTo,
      );
      allResults.push(...connResult.results);
      fetched += connResult.fetched;
      created += connResult.created;
      updated += connResult.updated;
      skippedLines += connResult.skipped_lines;
      unmatchedSkus += connResult.unmatched_skus;
    }

    return {
      fetched,
      created,
      updated,
      skipped_lines: skippedLines,
      unmatched_skus: unmatchedSkus,
      results: allResults,
    };
  }

  private async syncConnection(
    client: ShopeeClient,
    conn: ChannelConnection,
    createdById: bigint,
    timeFrom: number,
    timeTo: number,
  ) {
    const locationId = await this.resolveLocationId(conn);
    const fresh = await this.shopeeAuth.ensureFreshConnection(conn.id);

    const orderSns = await this.collectOrderSns(
      client,
      fresh.accessToken,
      fresh.shopId,
      timeFrom,
      timeTo,
    );
    if (!orderSns.length) {
      return {
        fetched: 0,
        created: 0,
        updated: 0,
        skipped_lines: 0,
        unmatched_skus: 0,
        results: [] as SyncOrderResult[],
      };
    }

    const orders: ShopeeOrderDetail[] = [];
    for (let i = 0; i < orderSns.length; i += 50) {
      const batch = orderSns.slice(i, i + 50);
      const detail = await client.getOrderDetail(
        fresh.accessToken,
        fresh.shopId,
        batch,
      );
      orders.push(...(detail.order_list ?? []));
    }

    const result = await this.applyOrders(
      orders,
      locationId,
      createdById,
      fresh.shopId,
    );

    this.logger.log(
      `Shopee sync shop ${fresh.shopId}: ${result.fetched} đơn — ${result.created} mới, ${result.updated} cập nhật`,
    );
    return result;
  }

  private async applyOrders(
    orders: ShopeeOrderDetail[],
    locationId: bigint,
    createdById: bigint,
    shopId: string,
  ) {
    const variantBySku = await this.loadVariants(orders);
    const gaps = new Map<string, SkuGap>();
    const results: SyncOrderResult[] = [];
    let created = 0;
    let updated = 0;
    let skippedLines = 0;

    for (const order of orders) {
      try {
        const outcome = await this.upsertOrder({
          order,
          locationId,
          createdById,
          variantBySku,
          gaps,
        });
        if (outcome.created) created++;
        else updated++;
        skippedLines += outcome.skippedLines;
        results.push({
          order_sn: order.order_sn,
          order_id: outcome.orderId.toString(),
          created: outcome.created,
          updated: !outcome.created,
          skipped_lines: outcome.skippedLines,
        });
      } catch (e) {
        const msg =
          e instanceof BusinessException
            ? e.message
            : e instanceof Error
              ? e.message
              : 'Lỗi không xác định';
        this.logger.warn(`Shopee đơn ${order.order_sn} shop ${shopId}: ${msg}`);
        results.push({ order_sn: order.order_sn ?? '', error: msg });
      }
    }

    await this.recordSkuGaps(gaps);

    return {
      fetched: orders.length,
      created,
      updated,
      skipped_lines: skippedLines,
      unmatched_skus: gaps.size,
      results,
    };
  }

  private async upsertOrder(args: {
    order: ShopeeOrderDetail;
    locationId: bigint;
    createdById: bigint;
    variantBySku: Map<string, VariantRef>;
    gaps: Map<string, SkuGap>;
  }) {
    const { order, locationId, createdById, variantBySku, gaps } = args;
    const orderSn = order.order_sn;
    if (!orderSn) {
      throw new BusinessException('VALIDATION_ERROR', 'Thiếu order_sn', 422);
    }

    const units = groupLineItems(order.item_list ?? []);
    const items: Prisma.OrderItemCreateManyOrderInput[] = [];
    let skippedLines = 0;

    for (const unit of units) {
      const variant = unit.sku ? variantBySku.get(unit.sku) : undefined;
      if (!variant) {
        skippedLines++;
        trackGap(gaps, unit, order);
        continue;
      }
      const unitPrice = unit.originalPrice;
      const discounted = unit.salePrice.mul(unit.quantity);
      items.push({
        variantId: variant.id,
        name: unit.productName ?? variant.sku,
        variantTitle: unit.variantTitle,
        sku: variant.sku,
        quantity: unit.quantity,
        price: unitPrice,
        totalDiscount: unitPrice.mul(unit.quantity).sub(discounted),
        discountedTotal: discounted,
        originalTotal: unitPrice.mul(unit.quantity),
        costPrice: variant.cost,
        currentQuantity: unit.quantity,
      });
    }

    const customerId = await this.resolveCustomer(order);
    const data = mapOrderFields(order, locationId, customerId);

    const existing = await this.prisma.order.findUnique({
      where: { name: orderSn },
      select: { id: true },
    });

    const fulfillment = mapFulfillmentRecord(order, locationId, createdById);
    let orderId!: bigint;
    await this.prisma.$transaction(async (tx) => {
      if (existing) {
        await tx.order.update({ where: { id: existing.id }, data });
        orderId = existing.id;
        await tx.orderItem.deleteMany({ where: { orderId } });
      } else {
        const row = await tx.order.create({
          data: { ...data, name: orderSn, createdById },
          select: { id: true },
        });
        orderId = row.id;
      }
      if (items.length) {
        await tx.orderItem.createMany({
          data: items.map((i) => ({ ...i, orderId })),
        });
      }

      if (fulfillment) {
        const { name, ...rest } = fulfillment;
        const shippingFields = {
          status: rest.status,
          shipmentStatus: rest.shipmentStatus,
          packedStatus: rest.packedStatus,
          deliveryMethod: rest.deliveryMethod,
          trackingNumber: rest.trackingNumber,
          carrierName: rest.carrierName,
          trackingCompany: rest.trackingCompany,
          shipmentCreatedOn: rest.shipmentCreatedOn,
          pickedUpAt: rest.pickedUpAt,
          deliveredOn: rest.deliveredOn,
          cancelledOn: rest.cancelledOn,
          codAmount: rest.codAmount,
          totalQuantity: rest.totalQuantity,
        };

        const target = await tx.fulfillment.findFirst({
          where: { OR: [{ name }, { orderId, closedAt: null }] },
          select: { id: true },
        });

        if (target) {
          await tx.fulfillment.update({
            where: { id: target.id },
            data: shippingFields,
          });
        } else {
          await tx.fulfillment.create({ data: { ...rest, name, orderId } });
        }
      }
    });

    return { created: !existing, skippedLines, orderId };
  }

  private async loadVariants(orders: ShopeeOrderDetail[]) {
    const skus = new Set<string>();
    for (const o of orders) {
      for (const line of o.item_list ?? []) {
        const sku = lineSku(line);
        if (sku) skus.add(sku);
      }
    }
    if (!skus.size) return new Map<string, VariantRef>();

    const variants = await this.prisma.productVariant.findMany({
      where: { sku: { in: [...skus] } },
      select: { id: true, sku: true, productId: true, cost: true },
    });
    return new Map(variants.map((v) => [v.sku, v]));
  }

  private async loadConnections(connectionId?: string) {
    if (connectionId) {
      const conn = await this.prisma.channelConnection.findFirst({
        where: { id: BigInt(connectionId), channel: OrderSource.shopee },
      });
      if (!conn) {
        throw new BusinessException(
          'CHANNEL_NOT_CONFIGURED',
          'Không tìm thấy kết nối Shopee',
          404,
        );
      }
      return [conn];
    }
    return this.prisma.channelConnection.findMany({
      where: { channel: OrderSource.shopee },
    });
  }

  private async recordSkuGaps(gaps: Map<string, SkuGap>) {
    for (const gap of gaps.values()) {
      await this.prisma.channelSkuGap.upsert({
        where: { channel_sku: { channel: 'shopee', sku: gap.sku } },
        create: {
          channel: 'shopee',
          sku: gap.sku,
          productName: gap.productName,
          variantName: gap.variantName,
          lineCount: gap.lineCount,
          quantity: gap.quantity,
          amount: gap.amount,
          firstSeenAt: gap.lastSeenAt,
          lastSeenAt: gap.lastSeenAt,
        },
        update: {
          productName: gap.productName,
          variantName: gap.variantName,
          lineCount: gap.lineCount,
          quantity: gap.quantity,
          amount: gap.amount,
          lastSeenAt: gap.lastSeenAt,
        },
      });
    }
  }

  private async collectOrderSns(
    client: ShopeeClient,
    accessToken: string,
    shopId: string,
    timeFrom: number,
    timeTo: number,
  ): Promise<string[]> {
    const seen = new Set<string>();

    for (const status of SYNC_STATUSES) {
      let cursor = '';
      let more = true;
      while (more) {
        const page = await client.getOrderList(accessToken, shopId, {
          timeRangeField: 'update_time',
          timeFrom,
          timeTo,
          orderStatus: status,
          cursor,
        });
        for (const row of page.order_list ?? []) {
          if (row.order_sn) seen.add(row.order_sn);
        }
        more = page.more;
        cursor = page.next_cursor ?? '';
        if (!more) break;
      }
    }

    return [...seen];
  }

  private isMasked(value: string): boolean {
    return value.includes('*');
  }

  private async resolveCustomer(
    order: ShopeeOrderDetail,
  ): Promise<bigint | null> {
    const addr = order.recipient_address;
    const phone = (addr?.phone ?? '').trim();
    const name = (addr?.name ?? order.buyer_username ?? '').trim();

    if (phone && !this.isMasked(phone)) {
      const existing = await this.prisma.customer.findFirst({
        where: { phone },
      });
      if (existing) return existing.id;
      const created = await this.prisma.customer.create({
        data: {
          phone,
          firstName: name || null,
        },
      });
      return created.id;
    }

    const pseudoPhone = `shopee-${order.buyer_user_id ?? order.order_sn}`;
    const existing = await this.prisma.customer.findFirst({
      where: { phone: pseudoPhone },
    });
    if (existing) return existing.id;
    const created = await this.prisma.customer.create({
      data: {
        phone: pseudoPhone,
        firstName: name || order.buyer_username || 'Shopee buyer',
      },
    });
    return created.id;
  }

  private async resolveLocationId(conn: ChannelConnection): Promise<bigint> {
    if (conn.locationId) return conn.locationId;

    const fromEnv = process.env.SHOPEE_DEFAULT_LOCATION_ID?.trim();
    if (fromEnv) return BigInt(fromEnv);

    const defaultLoc = await this.prisma.location.findFirst({
      where: { defaultLocation: true, status: 'active' },
      orderBy: { id: 'asc' },
    });
    if (defaultLoc) return defaultLoc.id;

    throw new BusinessException(
      'CHANNEL_NOT_CONFIGURED',
      `Shop Shopee ${conn.shopId}: chưa gán kho (channel_connections.location_id hoặc SHOPEE_DEFAULT_LOCATION_ID)`,
      422,
    );
  }

  private syncWindowDays(): number {
    const raw = process.env.SHOPEE_SYNC_WINDOW_DAYS?.trim();
    const n = raw ? Number(raw) : 15;
    if (!Number.isFinite(n) || n < 1) return 15;
    return Math.min(15, Math.floor(n));
  }
}

function groupLineItems(lines: ShopeeOrderItem[]): LineUnit[] {
  const units: LineUnit[] = [];
  for (const line of lines) {
    const sku = lineSku(line);
    const qty = line.model_quantity_purchased ?? 1;
    const original = toDecimal(
      line.model_original_price ?? line.model_discounted_price,
    );
    const sale = toDecimal(
      line.model_discounted_price ?? line.model_original_price,
    );
    units.push({
      sku: sku ?? '',
      productName: line.item_name ?? null,
      variantTitle: line.model_name ?? null,
      quantity: qty,
      originalPrice: original,
      salePrice: sale,
    });
  }
  return units;
}

function lineSku(line: ShopeeOrderItem): string | null {
  const sku = line.model_sku?.trim() || line.item_sku?.trim() || '';
  return sku || null;
}

function trackGap(
  gaps: Map<string, SkuGap>,
  unit: LineUnit,
  order: ShopeeOrderDetail,
) {
  if (!unit.sku) return;
  const seenAt = order.update_time
    ? new Date(order.update_time * 1000)
    : order.create_time
      ? new Date(order.create_time * 1000)
      : new Date();
  const current = gaps.get(unit.sku);
  if (current) {
    current.lineCount++;
    current.quantity += unit.quantity;
    current.amount = current.amount.add(unit.salePrice.mul(unit.quantity));
    if (seenAt > current.lastSeenAt) current.lastSeenAt = seenAt;
    return;
  }
  gaps.set(unit.sku, {
    sku: unit.sku,
    productName: unit.productName,
    variantName: unit.variantTitle,
    lineCount: 1,
    quantity: unit.quantity,
    amount: unit.salePrice.mul(unit.quantity),
    lastSeenAt: seenAt,
  });
}

function mapOrderFields(
  order: ShopeeOrderDetail,
  locationId: bigint,
  customerId: bigint | null,
) {
  const status = mapShopeeStatus(order.order_status);
  const shippingFee = toDecimal(
    order.estimated_shipping_fee ?? order.actual_shipping_fee,
  );
  const totalPrice = toDecimal(order.total_amount);
  const isCod = order.cod === true;
  const paidOn =
    !isCod && order.order_status !== 'UNPAID' && order.create_time
      ? new Date(order.create_time * 1000)
      : null;
  const updateAt = order.update_time
    ? new Date(order.update_time * 1000)
    : null;
  const createAt = order.create_time
    ? new Date(order.create_time * 1000)
    : new Date();

  const lines = order.item_list ?? [];
  let subTotal = new Prisma.Decimal(0);
  let totalDiscounts = new Prisma.Decimal(0);
  let subtotalQty = 0;
  for (const line of lines) {
    const qty = line.model_quantity_purchased ?? 1;
    const original = toDecimal(
      line.model_original_price ?? line.model_discounted_price,
    );
    const sale = toDecimal(
      line.model_discounted_price ?? line.model_original_price,
    );
    subTotal = subTotal.add(original.mul(qty));
    totalDiscounts = totalDiscounts.add(original.mul(qty).sub(sale.mul(qty)));
    subtotalQty += qty;
  }

  const addr = order.recipient_address;

  return {
    locationId,
    customerId,
    sourceName: 'shopee',
    status,
    financialStatus: paidOn
      ? OrderFinancialStatus.paid
      : OrderFinancialStatus.pending,
    fulfillmentStatus: mapFulfillment(order.order_status),
    cancelReason: status === OrderStatus.cancelled ? 'Shopee cancelled' : null,
    cancelledOn: status === OrderStatus.cancelled && updateAt ? updateAt : null,
    completedOn:
      order.order_status === 'COMPLETED' && updateAt ? updateAt : null,
    closedOn: status === OrderStatus.closed && updateAt ? updateAt : null,
    confirmedOn: createAt,
    paidOn,
    // Giống TikTok: `fulfilled` khi hàng rời kho (SHIPPED≈IN_TRANSIT); `deliveredOn` chỉ
    // khi đơn thực sự hoàn tất giao (COMPLETED≈có delivery_time).
    deliveredOn:
      order.order_status === 'COMPLETED' && updateAt ? updateAt : null,
    createdOn: createAt,

    subTotalPrice: subTotal,
    totalDiscounts,
    totalTax: new Prisma.Decimal(0),
    totalShippingPrice: shippingFee,
    totalPrice: totalPrice.gt(0) ? totalPrice : subTotal.add(shippingFee),
    subtotalLineItemsQuantity: subtotalQty,
    totalReceived: paidOn ? totalPrice : new Prisma.Decimal(0),
    currency: order.currency ?? 'VND',
    gateway: order.payment_method ?? null,
    shippingMethod: order.shipping_carrier?.trim() || null,
    deliveryCodAmount: isCod ? totalPrice : null,
    note: order.message_to_seller?.trim() || null,
    phone: addr?.phone?.trim() || null,

    shippingName: addr?.name?.trim() || null,
    shippingPhone: addr?.phone?.trim() || null,
    shippingAddress1: addr?.full_address?.trim() || null,
    shippingDistrict: addr?.district?.trim() || addr?.town?.trim() || null,
    shippingProvince: addr?.state?.trim() || addr?.region?.trim() || null,
    shippingCity: addr?.city?.trim() || null,
    shippingZip: addr?.zipcode?.trim() || null,
  } satisfies Prisma.OrderUncheckedUpdateInput & Record<string, unknown>;
}

/**
 * Shopee: UNPAID | READY_TO_SHIP | PROCESSED | SHIPPED | COMPLETED | CANCELLED | IN_CANCEL.
 * `COMPLETED` = đóng đơn; huỷ (kể cả đang xin huỷ) = cancelled.
 */
function mapShopeeStatus(status?: string): OrderStatus {
  if (status === 'CANCELLED' || status === 'IN_CANCEL') {
    return OrderStatus.cancelled;
  }
  if (status === 'COMPLETED') return OrderStatus.closed;
  return OrderStatus.open;
}

/** Hàng đã rời kho (SHIPPED trở đi) — cùng ngưỡng TikTok IN_TRANSIT/DELIVERED/COMPLETED. */
function mapFulfillment(status?: string): OrderFulfillmentStatus | null {
  if (status === 'SHIPPED' || status === 'COMPLETED') {
    return OrderFulfillmentStatus.fulfilled;
  }
  return null;
}

/**
 * Vận đơn cho đơn sàn Shopee — cùng quy ước TikTok: `delivery_method = ecommerce`,
 * `provider_id` NULL, hãng thật ở `carrier_name`.
 */
function mapFulfillmentRecord(
  order: ShopeeOrderDetail,
  locationId: bigint,
  createdById: bigint,
) {
  const pkg = order.package_list?.[0];
  const packageNumber = pkg?.package_number?.trim();
  const tracking = (pkg?.tracking_number ?? '').trim();
  const validTracking = tracking && tracking !== '-' ? tracking : null;
  const orderStatus = order.order_status;

  const hasShippingActivity =
    orderStatus === 'PROCESSED' ||
    orderStatus === 'SHIPPED' ||
    orderStatus === 'COMPLETED' ||
    orderStatus === 'CANCELLED' ||
    orderStatus === 'IN_CANCEL';

  if (!packageNumber && !validTracking && !hasShippingActivity) return null;

  const shipmentStatus = mapShipmentStatus(orderStatus, pkg?.logistics_status);
  if (!shipmentStatus) return null;

  const at = (unix?: number) => (unix ? new Date(unix * 1000) : null);
  const updateAt = at(order.update_time);
  const carrier =
    pkg?.shipping_carrier?.trim() || order.shipping_carrier?.trim() || null;
  const totalPrice = toDecimal(order.total_amount);

  return {
    name: `SPE-${packageNumber ?? validTracking ?? order.order_sn}`,
    status:
      orderStatus === 'CANCELLED' || orderStatus === 'IN_CANCEL'
        ? 'cancelled'
        : 'success',
    shipmentStatus,
    deliveryMethod: FulfillmentDeliveryMethod.ecommerce,
    packedStatus:
      orderStatus === 'PROCESSED' ||
      orderStatus === 'SHIPPED' ||
      orderStatus === 'COMPLETED'
        ? PackingStatus.packed
        : PackingStatus.unknown,
    trackingNumber: validTracking,
    carrierName: carrier,
    trackingCompany: carrier,
    locationId,
    createdById,
    shipmentCreatedOn: at(order.create_time),
    pickedUpAt: at(order.pickup_done_time),
    deliveredOn:
      orderStatus === 'COMPLETED' ||
      pkg?.logistics_status === 'LOGISTICS_DELIVERY_DONE'
        ? updateAt
        : null,
    cancelledOn:
      orderStatus === 'CANCELLED' || orderStatus === 'IN_CANCEL'
        ? updateAt
        : null,
    codAmount: order.cod === true ? totalPrice : new Prisma.Decimal(0),
    totalQuantity:
      order.item_list?.reduce(
        (sum, i) => sum + (i.model_quantity_purchased ?? 1),
        0,
      ) ?? 0,
  };
}

/** Shopee `order_status` + `logistics_status` → `shipment_status` nội bộ. */
function mapShipmentStatus(
  orderStatus?: string,
  logisticsStatus?: string,
): ShipmentStatus | null {
  if (orderStatus === 'CANCELLED' || orderStatus === 'IN_CANCEL') {
    return ShipmentStatus.cancelled;
  }

  if (logisticsStatus) {
    switch (logisticsStatus) {
      case 'LOGISTICS_NOT_START':
      case 'LOGISTICS_READY':
      case 'LOGISTICS_REQUEST_CREATED':
      case 'LOGISTICS_PENDING_ARRANGE':
        return ShipmentStatus.pending;
      case 'LOGISTICS_PICKUP_DONE':
        return ShipmentStatus.picked_up;
      case 'LOGISTICS_DELIVERY_DONE':
        return ShipmentStatus.delivered;
      case 'LOGISTICS_PICKUP_RETRY':
        return ShipmentStatus.retry_delivery;
      case 'LOGISTICS_PICKUP_FAILED':
      case 'LOGISTICS_DELIVERY_FAILED':
      case 'LOGISTICS_LOST':
      case 'LOGISTICS_INVALID':
      case 'LOGISTICS_REQUEST_CANCELED':
        return ShipmentStatus.cancelled;
      default:
        break;
    }
  }

  switch (orderStatus) {
    case 'PROCESSED':
      return ShipmentStatus.pending;
    case 'SHIPPED':
      return ShipmentStatus.delivering;
    case 'COMPLETED':
      return ShipmentStatus.delivered;
    default:
      return null;
  }
}

function toDecimal(v?: number | null): Prisma.Decimal {
  if (v == null || !Number.isFinite(v)) return new Prisma.Decimal(0);
  return new Prisma.Decimal(v);
}
