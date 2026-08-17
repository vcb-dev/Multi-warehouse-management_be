import { Injectable, Logger } from '@nestjs/common';
import { ChannelConnection, OrderSource } from '@prisma/client';
import { AuthUser } from '../../../common/decorators/current-user.decorator';
import { BusinessException } from '../../../common/exceptions/business.exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { ShippingAddressDto } from '../../orders/order.dto';
import { OrderService } from '../../orders/order.service';
import { ShopeeAuthService } from './shopee-auth.service';
import {
  ShopeeClient,
  ShopeeOrderDetail,
  ShopeeOrderItem,
} from './shopee.client';

const SYNC_STATUSES = [
  'UNPAID',
  'READY_TO_SHIP',
  'PROCESSED',
  'SHIPPED',
  'COMPLETED',
] as const;

const SKIP_STATUSES = new Set(['CANCELLED', 'IN_CANCEL']);

type SyncOrderResult = {
  order_sn: string;
  order_id?: string;
  code?: string;
  skipped?: boolean;
  error?: string;
};

@Injectable()
export class ShopeeSyncService {
  private readonly logger = new Logger(ShopeeSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shopeeAuth: ShopeeAuthService,
    private readonly orders: OrderService,
  ) {}

  async syncShopeeOrders(
    user: AuthUser,
    connectionId?: string,
  ): Promise<{
    synced: number;
    skipped: number;
    results: SyncOrderResult[];
  }> {
    const client = this.shopeeAuth.getClient();
    const connections = await this.loadConnections(connectionId);
    const results: SyncOrderResult[] = [];

    for (const conn of connections) {
      const connResults = await this.syncConnection(client, conn, user);
      results.push(...connResults);
    }

    const synced = results.filter((r) => r.order_id).length;
    const skipped = results.filter((r) => r.skipped).length;
    return { synced, skipped, results };
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

  private async syncConnection(
    client: ShopeeClient,
    conn: ChannelConnection,
    user: AuthUser,
  ): Promise<SyncOrderResult[]> {
    const locationId = await this.resolveLocationId(conn);
    const fresh = await this.shopeeAuth.ensureFreshConnection(conn.id);
    const windowDays = this.syncWindowDays();
    const timeTo = Math.floor(Date.now() / 1000);
    const timeFrom = timeTo - windowDays * 24 * 60 * 60;

    const orderSns = await this.collectOrderSns(
      client,
      fresh.accessToken,
      fresh.shopId,
      timeFrom,
      timeTo,
    );
    if (!orderSns.length) return [];

    const results: SyncOrderResult[] = [];
    for (let i = 0; i < orderSns.length; i += 50) {
      const batch = orderSns.slice(i, i + 50);
      const detail = await client.getOrderDetail(
        fresh.accessToken,
        fresh.shopId,
        batch,
      );
      for (const order of detail.order_list ?? []) {
        results.push(
          await this.importOrder(order, locationId, user, fresh.shopId),
        );
      }
    }

    this.logger.log(
      `Shopee sync shop ${fresh.shopId}: ${results.filter((r) => r.order_id).length}/${results.length} đơn`,
    );
    return results;
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

  private async importOrder(
    order: ShopeeOrderDetail,
    locationId: bigint,
    user: AuthUser,
    shopId: string,
  ): Promise<SyncOrderResult> {
    const orderSn = order.order_sn;
    if (!orderSn) {
      return { order_sn: '', error: 'Thiếu order_sn' };
    }

    if (order.order_status && SKIP_STATUSES.has(order.order_status)) {
      return { order_sn: orderSn, skipped: true };
    }

    const existing = await this.prisma.order.findUnique({
      where: { name: orderSn },
      select: { id: true, name: true },
    });
    if (existing) {
      return {
        order_sn: orderSn,
        skipped: true,
        code: existing.name,
        order_id: existing.id.toString(),
      };
    }

    try {
      const items = await this.resolveLineItems(order, locationId);
      const customerId = await this.resolveCustomer(order);
      const shipping = this.mapShippingAddress(order);
      const shippingFee =
        order.estimated_shipping_fee ?? order.actual_shipping_fee ?? 0;
      const totalAmount = order.total_amount ?? 0;
      const isCod = order.cod === true;
      const paidAmount = isCod ? 0 : totalAmount;

      const created = await this.orders.createFromResolvedItems(
        {
          locationId,
          sourceName: 'shopee',
          customerId,
          items,
          name: orderSn,
          createdOn: order.create_time
            ? new Date(order.create_time * 1000)
            : undefined,
          totalShippingPrice: shippingFee,
          totalReceived: paidAmount,
          deliveryCodAmount: isCod ? totalAmount : undefined,
          shippingMethod: order.shipping_carrier?.trim() || undefined,
          note: order.message_to_seller?.trim() || undefined,
          phone: shipping.phone,
          shippingAddress: shipping,
        },
        user,
      );

      return {
        order_sn: orderSn,
        order_id: created.id,
        code: created.code,
      };
    } catch (e) {
      const msg =
        e instanceof BusinessException
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Lỗi không xác định';
      this.logger.warn(`Shopee đơn ${orderSn} shop ${shopId}: ${msg}`);
      return { order_sn: orderSn, error: msg };
    }
  }

  private async resolveLineItems(order: ShopeeOrderDetail, locationId: bigint) {
    const lines = order.item_list ?? [];
    if (!lines.length) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Đơn Shopee không có dòng hàng',
        422,
      );
    }

    const resolved = [];
    for (const line of lines) {
      const sku = this.lineSku(line);
      if (!sku) {
        throw new BusinessException(
          'VALIDATION_ERROR',
          `Đơn ${order.order_sn}: dòng "${line.item_name ?? '?'}" thiếu SKU`,
          422,
        );
      }
      const variant = await this.prisma.productVariant.findUnique({
        where: { sku },
        include: { product: true },
      });
      if (!variant) {
        throw new BusinessException(
          'VALIDATION_ERROR',
          `Đơn ${order.order_sn}: SKU "${sku}" chưa có trong hệ thống`,
          422,
        );
      }

      const qty = line.model_quantity_purchased ?? 1;
      const price =
        line.model_original_price ?? line.model_discounted_price ?? 0;
      const discounted = line.model_discounted_price ?? price;
      const lineDiscount = Math.max(0, (price - discounted) * qty);

      resolved.push({
        variantId: variant.id,
        locationId,
        productName: variant.product.name,
        sku: variant.sku,
        quantity: qty,
        price,
        discount: lineDiscount,
        total: discounted * qty,
        costPrice: variant.cost,
      });
    }
    return resolved;
  }

  private lineSku(line: ShopeeOrderItem): string | null {
    const sku = line.model_sku?.trim() || line.item_sku?.trim() || '';
    return sku || null;
  }

  private async resolveCustomer(order: ShopeeOrderDetail): Promise<bigint> {
    const addr = order.recipient_address;
    const phone = (addr?.phone ?? '').trim();
    const name = (addr?.name ?? order.buyer_username ?? '').trim();

    if (phone) {
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

  private mapShippingAddress(order: ShopeeOrderDetail): ShippingAddressDto {
    const addr = order.recipient_address;
    if (!addr) return {};
    return {
      name: addr.name,
      phone: addr.phone,
      address1: addr.full_address,
      city: addr.city,
      district: addr.district ?? addr.town,
      province: addr.state ?? addr.region,
      zip: addr.zipcode,
    };
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
