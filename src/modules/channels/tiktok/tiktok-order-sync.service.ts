import { Injectable, Logger } from '@nestjs/common';
import {
  FulfillmentDeliveryMethod,
  NotificationTopic,
  OrderFinancialStatus,
  OrderFulfillmentStatus,
  OrderStatus,
  PackingStatus,
  Prisma,
  ShipmentStatus,
} from '@prisma/client';
import { BusinessException } from '../../../common/exceptions/business.exception';
import { NotificationService } from '../../notifications/notification.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { marketplaceOrderUrl } from '../channel-order-link';
import {
  TiktokApiClient,
  TiktokOrder,
  TiktokOrderLine,
} from './tiktok-api.client';
import { TiktokAuthService } from './tiktok-auth.service';

/**
 * Đơn đặt cách đây quá số giờ này thì kéo về im lặng, không sinh thông báo.
 * Mục đích duy nhất: sync bù khoảng đã hụt không làm ngập chuông bằng đơn cũ.
 */
/**
 * Hạn cho giao dịch ghi một đơn. Mặc định của Prisma là 5 giây — quá ngắn cho DB dùng
 * chung: đo 2026-08-18, một lượt backfill tháng 5 chết giữa chừng với
 * "Transaction already closed ... 67905 ms passed since the start of the transaction"
 * vì phải xếp hàng chờ connection với cron 15 phút đang chạy song song.
 */
const ORDER_TX_OPTIONS = { maxWait: 15_000, timeout: 30_000 };

const SYNC_NOTIFY_MAX_AGE_HOURS = Number(
  process.env.SYNC_NOTIFY_MAX_AGE_HOURS ?? 24,
);

/**
 * Kéo đơn thẳng từ TikTok Shop Open API vào bảng `orders` — KHÔNG đi qua Sapo.
 *
 * Vì sao cần: đồng bộ qua Sapo đứt từ 03/08/2026, đối chiếu ngày 15/08 cho thấy TikTok có
 * 638 đơn trong tháng còn DB chỉ có 107. Kênh này giờ tự lấy đơn về, không phụ thuộc Sapo.
 *
 * Ba quy ước quan trọng, đều chốt từ dữ liệu thật chứ không phải mặc định cho tiện:
 *
 * 1. **Chống trùng theo `orders.name`.** Đơn TikTok mà Sapo đẩy về đã dùng đúng mã đơn
 *    TikTok làm `name` (`585350619199341650`), nên upsert theo `name` sẽ gộp đúng vào đơn
 *    cũ thay vì tạo bản sao. TikTok là nguồn thật nên ghi đè.
 *
 * 2. **Không đụng tồn kho.** Ghi thẳng bằng Prisma, không gọi `OrderService`, nên không
 *    sinh `inventory_movements` — giống hệt đường đơn Sapo đang vào. Đơn sàn đã trừ kho ở
 *    phía sàn rồi; tạo movement ở đây sẽ trừ kho hai lần.
 *
 * 3. **SKU lạ thì bỏ dòng, không bỏ đơn.** `order_items.variant_id` là FK bắt buộc nên
 *    dòng hàng có `seller_sku` không khớp `product_variants.sku` không chèn được. Bỏ dòng
 *    đó nhưng vẫn ghi đơn (tổng tiền lấy từ TikTok nên doanh thu vẫn đúng), rồi ghi vết vào
 *    `channel_sku_gaps` để màn Kênh bán chỉ ra đang thiếu SKU nào — thay vì nuốt im lặng.
 */
@Injectable()
export class TiktokOrderSyncService {
  private readonly logger = new Logger(TiktokOrderSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: TiktokAuthService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Đồng bộ theo khoảng ngày. `filterBy` quyết định lọc theo ngày tạo hay ngày cập nhật:
   * - `created` (mặc định) — lấy đơn MỚI của khoảng ngày, hợp với backfill và nút bấm tay.
   * - `updated` — lấy đơn CÓ THAY ĐỔI trong khoảng, bắt được cả đơn cũ vừa đổi trạng thái.
   */
  async syncOrders(params: {
    /** YYYY-MM-DD, theo giờ Việt Nam. Bỏ trống = 7 ngày gần nhất. */
    from?: string;
    to?: string;
    filterBy?: 'created' | 'updated';
    createdById: bigint;
  }) {
    const { timeGe, timeLt, from, toExclusive } = resolveRange(
      params.from,
      params.to,
    );
    const filterBy = params.filterBy ?? 'created';

    const ctx = await this.prepare();
    const orders = await this.fetchAllOrders(ctx, timeGe, timeLt, filterBy);
    this.logger.log(
      `TikTok trả về ${orders.length} đơn (lọc theo ${filterBy}) cho ${from.toISOString()} → ${toExclusive.toISOString()}`,
    );

    const result = await this.applyOrders(orders, ctx, params.createdById);
    return {
      shop_name: ctx.shopName,
      from,
      to: new Date(toExclusive.getTime() - 1000),
      filter_by: filterBy,
      ...result,
    };
  }

  /**
   * Quét cửa sổ ngắn vừa qua theo `update_time` — dành cho cron. Cửa sổ nên rộng hơn chu kỳ
   * chạy để hai lần quét chồng lấn nhau; sync là idempotent (upsert theo `orders.name`) nên
   * quét trùng không sinh đơn thừa, còn quét hụt thì mất đơn vĩnh viễn.
   */
  async syncRecent(windowMinutes: number, createdById: bigint) {
    const now = Math.floor(Date.now() / 1000);
    const ctx = await this.prepare();
    const orders = await this.fetchAllOrders(
      ctx,
      now - windowMinutes * 60,
      now,
      'updated',
    );
    const result = await this.applyOrders(orders, ctx, createdById);
    return {
      shop_name: ctx.shopName,
      window_minutes: windowMinutes,
      ...result,
    };
  }

  /**
   * Đồng bộ đúng vài đơn theo mã — dành cho webhook. Webhook chỉ báo "đơn X vừa đổi", nội
   * dung của nó KHÔNG được tin; ở đây tự gọi lại TikTok lấy đơn thật rồi mới ghi.
   */
  async syncOrderIds(orderIds: string[], createdById: bigint) {
    if (!orderIds.length)
      return {
        fetched: 0,
        created: 0,
        updated: 0,
        skipped_lines: 0,
        kept_existing_lines: 0,
        failed: 0,
        unmatched_skus: 0,
      };

    const ctx = await this.prepare();
    const orders: TiktokOrder[] = [];
    // `getOrderDetail` nhận nhiều id một lượt; chia lô cho an toàn với giới hạn độ dài URL
    for (let i = 0; i < orderIds.length; i += 20) {
      const res = await ctx.client.getOrderDetail(
        ctx.shopCipher,
        orderIds.slice(i, i + 20),
      );
      orders.push(...(res.orders ?? []));
    }
    return this.applyOrders(orders, ctx, createdById);
  }

  /** Token còn hạn + shop cipher + kho nhận đơn — mọi luồng đồng bộ đều cần bộ ba này. */
  private async prepare(): Promise<SyncContext> {
    const conn = await this.connectionWithFreshToken();
    if (!conn.locationId) {
      throw new BusinessException(
        'CHANNEL_NOT_CONFIGURED',
        'Chưa gán kho cho kết nối TikTok Shop — vào Cấu hình > Kênh bán để chọn kho nhận đơn',
        422,
      );
    }

    const client = new TiktokApiClient(
      process.env.TIKTOK_APP_KEY!.trim(),
      process.env.TIKTOK_APP_SECRET!.trim(),
      conn.accessToken,
    );

    const shops = await client.getAuthorizedShops();
    const shop = shops[0];
    if (!shop) {
      throw new BusinessException(
        'CHANNEL_AUTH_ERROR',
        'Token TikTok không gắn với gian hàng nào — cần ủy quyền lại',
        422,
      );
    }

    return {
      client,
      shopCipher: shop.cipher,
      shopId: shop.id,
      shopName: shop.name,
      locationId: conn.locationId,
    };
  }

  /** Ghi một mẻ đơn xuống DB. Dùng chung cho cả ba đường vào (tay, cron, webhook). */
  private async applyOrders(
    orders: TiktokOrder[],
    ctx: SyncContext,
    createdById: bigint,
  ) {
    const variantBySku = await this.loadVariants(orders);

    let created = 0;
    let updated = 0;
    let skippedLines = 0;
    let keptExistingLines = 0;
    let failed = 0;
    const gaps = new Map<string, SkuGap>();

    for (const order of orders) {
      // Bọc từng đơn: một đơn hỏng (giao dịch quá hạn, dữ liệu lạ) mà ném ra ngoài là mất
      // trọn phần còn lại của khoảng quét. Đo 2026-08-18: đúng một giao dịch quá hạn đã
      // giết cả lượt backfill tháng 5. Ghi log rồi đi tiếp; lượt quét sau sẽ vá lại vì
      // sync là idempotent.
      try {
        const outcome = await this.upsertOrder({
          order,
          locationId: ctx.locationId,
          createdById,
          shop: { id: ctx.shopId, name: ctx.shopName },
          variantBySku,
          gaps,
        });
        if (outcome.created) created++;
        else updated++;
        skippedLines += outcome.skippedLines;
        if (outcome.keptExistingLines) keptExistingLines++;
      } catch (e) {
        failed++;
        this.logger.error(
          `Ghi đơn TikTok ${order.id} lỗi: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    await this.recordSkuGaps(gaps);

    return {
      fetched: orders.length,
      created,
      updated,
      skipped_lines: skippedLines,
      /** Đơn giữ nguyên dòng hàng cũ vì khớp SKU chưa đủ — xem `upsertOrder()`. */
      kept_existing_lines: keptExistingLines,
      /** Đơn ghi hỏng — đã bỏ qua để lượt quét đi tiếp, xem log để biết đơn nào. */
      failed,
      unmatched_skus: gaps.size,
    };
  }

  /**
   * Access token TikTok chỉ sống 7 ngày. Làm mới sớm 1 ngày để một lần chạy dài không bị
   * hết hạn giữa chừng; refresh token sống tới 2125 nên không lo hỏng vòng làm mới.
   */
  private async connectionWithFreshToken() {
    const conn = await this.prisma.channelConnection.findFirst({
      where: { channel: 'tiktok' },
      orderBy: { createdAt: 'desc' },
    });
    if (!conn) {
      throw new BusinessException(
        'CHANNEL_NOT_CONFIGURED',
        'Chưa kết nối TikTok Shop — cần ủy quyền trước khi đồng bộ đơn',
        422,
      );
    }

    const oneDay = 24 * 60 * 60 * 1000;
    if (conn.accessTokenExpiresAt.getTime() - Date.now() > oneDay) return conn;

    this.logger.log('Access token TikTok sắp hết hạn, đang làm mới');
    return this.auth.refreshConnection(conn.id);
  }

  private async fetchAllOrders(
    ctx: SyncContext,
    timeGe: number,
    timeLt: number,
    filterBy: 'created' | 'updated',
  ): Promise<TiktokOrder[]> {
    const all: TiktokOrder[] = [];
    let pageToken: string | undefined;
    let page = 0;

    const window =
      filterBy === 'updated'
        ? { updateTimeGe: timeGe, updateTimeLt: timeLt }
        : { createTimeGe: timeGe, createTimeLt: timeLt };

    do {
      const res = await ctx.client.searchOrders({
        shopCipher: ctx.shopCipher,
        ...window,
        pageSize: 100,
        pageToken,
      });
      all.push(...(res.orders ?? []));
      pageToken = res.next_page_token || undefined;
      page++;
      // Chặn trên phòng `next_page_token` lặp vô hạn — 500 trang = 50.000 đơn, quá thừa
    } while (pageToken && page < 500);

    return all;
  }

  /** Nạp một lượt toàn bộ variant cần dùng, tránh N+1 khi có hàng trăm đơn. */
  private async loadVariants(orders: TiktokOrder[]) {
    const skus = new Set<string>();
    for (const o of orders) {
      for (const li of o.line_items ?? []) {
        const sku = (li.seller_sku ?? '').trim();
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

  private async upsertOrder(args: {
    order: TiktokOrder;
    locationId: bigint;
    createdById: bigint;
    shop: { id: string; name: string };
    variantBySku: Map<string, VariantRef>;
    gaps: Map<string, SkuGap>;
  }) {
    const { order, locationId, createdById, shop, variantBySku, gaps } = args;

    const units = groupLineItems(order.line_items ?? []);
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
        // Chốt giá vốn tại thời điểm đồng bộ để báo cáo lợi nhuận kỳ cũ không trôi
        costPrice: variant.cost,
        currentQuantity: unit.quantity,
      });
    }

    const data = mapOrderFields(order, locationId, shop);

    const existing = await this.prisma.order.findUnique({
      where: { name: order.id },
      select: { id: true },
    });

    const fulfillment = mapFulfillmentRecord(order, locationId, createdById);
    let newOrderId: bigint | null = null;

    const replaceItems = shouldReplaceLineItems(skippedLines, items.length);
    let keptExistingLines = false;

    await this.prisma.$transaction(async (tx) => {
      let orderId: bigint;
      if (existing) {
        await tx.order.update({ where: { id: existing.id }, data });
        orderId = existing.id;
        if (replaceItems) {
          await tx.orderItem.deleteMany({ where: { orderId } });
        } else {
          keptExistingLines = true;
        }
      } else {
        const row = await tx.order.create({
          data: { ...data, name: order.id, createdById },
          select: { id: true },
        });
        orderId = row.id;
        newOrderId = orderId;
      }
      // Đơn mới thì cứ ghi phần khớp được (có còn hơn không); đơn cũ chỉ ghi khi đã xoá.
      if (items.length && (!existing || replaceItems)) {
        await tx.orderItem.createMany({
          data: items.map((i) => ({ ...i, orderId })),
        });
      }

      // Vận đơn: chỉ có khi TikTok đã tạo kiện và giao cho hãng.
      //
      // KHÔNG dùng `upsert` theo `name` được: DB có partial unique index
      // `fulfillments_one_open_per_order` (order_id WHERE closed_at IS NULL) — mỗi đơn chỉ
      // được một vận đơn đang mở. Ràng buộc này KHÔNG có trong schema.prisma nên `tsc` không
      // thấy; tạo thêm dòng mới cho đơn đã có vận đơn Sapo (mã FUN...) sẽ vỡ ở tầng DB.
      // Vì vậy: ưu tiên khớp theo `name` của mình, không có thì ghi đè lên vận đơn đang mở
      // sẵn của đơn đó (cùng một kiện hàng thật, chỉ khác nguồn tạo), cuối cùng mới tạo mới.
      if (fulfillment) {
        const { name, ...rest } = fulfillment;
        // Chỉ những trường TikTok là nguồn thật; giữ nguyên `name`/`createdById`/`createdOn`
        // của bản ghi cũ để không xoá dấu vết ai tạo nó lần đầu.
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
    }, ORDER_TX_OPTIONS);

    if (newOrderId !== null) {
      this.notifyNewSyncedOrder(newOrderId, order, data, locationId);
    }

    return { created: !existing, skippedLines, keptExistingLines };
  }

  /**
   * Thông báo "đơn hàng mới" cho đơn TikTok vừa kéo về. Đây là NGUỒN ĐƠN LỚN NHẤT của
   * hệ thống — trước đây im lặng hoàn toàn vì sync ghi thẳng `tx.order.create()`, không
   * đi qua `OrderService.create()` (nơi duy nhất có `emit`).
   *
   * ⚠️ Chốt chặn backfill: chỉ báo đơn ĐẶT TRONG {@link SYNC_NOTIFY_MAX_AGE_HOURS} giờ
   * gần đây. Sync bù các khoảng đã hụt (hiện còn ~3.043 đơn Sapo chưa về) sẽ tạo hàng
   * nghìn đơn cũ một lúc — không có chặn này thì mỗi nhân viên nhận vài nghìn thông báo
   * về đơn từ tháng trước, chuông thành vô dụng vĩnh viễn.
   */
  private notifyNewSyncedOrder(
    orderId: bigint,
    order: TiktokOrder,
    data: { createdOn?: Date | null },
    locationId: bigint,
  ) {
    const placedAt = data.createdOn ?? null;
    if (!placedAt) return;

    const ageHours = (Date.now() - placedAt.getTime()) / 3_600_000;
    if (ageHours > SYNC_NOTIFY_MAX_AGE_HOURS) return;

    void this.notifications.emit(NotificationTopic.orders_create, {
      subjectType: 'order',
      subjectId: orderId,
      locationId,
      title: `Đơn TikTok mới ${order.id}`,
      payload: { code: order.id, source_name: 'tiktok' },
    });
  }

  /** Cộng dồn SKU chưa khớp vào `channel_sku_gaps` để UI hiển thị được. */
  private async recordSkuGaps(gaps: Map<string, SkuGap>) {
    for (const gap of gaps.values()) {
      await this.prisma.channelSkuGap.upsert({
        where: { channel_sku: { channel: 'tiktok', sku: gap.sku } },
        create: {
          channel: 'tiktok',
          sku: gap.sku,
          productName: gap.productName,
          variantName: gap.variantName,
          lineCount: gap.lineCount,
          quantity: gap.quantity,
          amount: gap.amount,
          firstSeenAt: gap.lastSeenAt,
          lastSeenAt: gap.lastSeenAt,
        },
        // Ghi đè chứ không cộng dồn: mỗi lần chạy quét lại trọn khoảng thời gian nên cộng
        // dồn sẽ thổi số lên gấp bội sau vài lần đồng bộ cùng một khoảng.
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
}

type SyncContext = {
  client: TiktokApiClient;
  shopCipher: string;
  /** Mã gian hàng trên TikTok (`shops[].id`) — ghi vào `orders.channel_shop_id`. */
  shopId: string;
  shopName: string;
  locationId: bigint;
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

/** Một SKU trong đơn, đã gộp các `line_items` lẻ thành số lượng. */
type OrderUnit = {
  sku: string;
  productName: string | null;
  variantTitle: string | null;
  quantity: number;
  originalPrice: Prisma.Decimal;
  salePrice: Prisma.Decimal;
};

/**
 * TikTok trả mỗi đơn vị hàng thành một phần tử `line_items` riêng và không có trường
 * `quantity` — mua 2 cái cùng SKU ra 2 phần tử. Gộp theo `sku_id` (không phải `seller_sku`,
 * vì hai biến thể khác nhau có thể trùng SKU người bán đặt nhầm).
 */
function groupLineItems(lines: TiktokOrderLine[]): OrderUnit[] {
  const bySkuId = new Map<string, OrderUnit>();
  for (const li of lines) {
    const key = li.sku_id ?? li.seller_sku ?? li.id;
    const existing = bySkuId.get(key);
    if (existing) {
      existing.quantity++;
      continue;
    }
    bySkuId.set(key, {
      sku: (li.seller_sku ?? '').trim(),
      productName: li.product_name ?? null,
      variantTitle: li.sku_name ?? null,
      quantity: 1,
      originalPrice: toDecimal(li.original_price),
      salePrice: toDecimal(li.sale_price),
    });
  }
  return [...bySkuId.values()];
}

/**
 * Có được phép thay toàn bộ dòng hàng của một đơn ĐÃ CÓ trong DB không.
 *
 * Đơn sàn có thể đổi/huỷ từng dòng nên cách đúng là thay cả cụm, không ghép từng dòng —
 * ghép sẽ để lại rác của lần đồng bộ trước. Nhưng thay khi đang khớp SKU thiếu thì còn tệ
 * hơn nhiều: lệnh xoá vẫn chạy, phần ghi lại thì thiếu, kết quả là đơn trơ mỗi tổng tiền.
 * Đo 2026-08-18: **90 đơn** có từ trước ngày bật sync trực tiếp đã mất sạch dòng hàng theo
 * đúng đường này — dòng cũ do Sapo map đúng bị xoá, dòng mới không chèn được vì
 * `seller_sku` không có trong `product_variants`.
 *
 * Vế `matched > 0` không thừa: TikTok thỉnh thoảng trả `line_items` rỗng, khi đó
 * `skipped` cũng bằng 0 và một mình vế đầu vẫn cho phép xoá sạch.
 */
export function shouldReplaceLineItems(skipped: number, matched: number) {
  return skipped === 0 && matched > 0;
}

function trackGap(
  gaps: Map<string, SkuGap>,
  unit: OrderUnit,
  order: TiktokOrder,
) {
  const seenAt = order.create_time
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
  order: TiktokOrder,
  locationId: bigint,
  shop: { id: string; name: string },
) {
  const p = order.payment ?? {};
  const status = mapStatus(order.status);
  const totalPrice = toDecimal(p.total_amount);
  const paidOn = order.paid_time ? new Date(order.paid_time * 1000) : null;

  return {
    locationId,
    // Giữ đúng chuỗi Sapo vẫn dùng để đơn kéo trực tiếp và đơn cũ nằm chung một kênh trên
    // báo cáo — `CHANNEL_DEFS` gom `tiktokshop` vào kênh `tiktok`.
    sourceName: 'tiktokshop',
    // "Mã tham chiếu" — với TikTok, mã đơn sàn trùng luôn `orders.name`; vẫn ghi cột riêng
    // để mọi kênh tra cứu cùng một chỗ, không phải biết trước kênh nào lấy mã ở đâu.
    sourceIdentifier: order.id,
    sourceUrl: marketplaceOrderUrl('tiktok', order.id),
    channelShopId: shop.id,
    channelShopName: shop.name,
    status,
    financialStatus: paidOn
      ? OrderFinancialStatus.paid
      : OrderFinancialStatus.pending,
    fulfillmentStatus: mapFulfillment(order.status),
    cancelReason:
      status === OrderStatus.cancelled ? (order.cancel_reason ?? null) : null,
    cancelledOn:
      status === OrderStatus.cancelled && order.update_time
        ? new Date(order.update_time * 1000)
        : null,
    completedOn:
      order.status === 'COMPLETED' && order.update_time
        ? new Date(order.update_time * 1000)
        : null,
    closedOn:
      status === OrderStatus.closed && order.update_time
        ? new Date(order.update_time * 1000)
        : null,
    // Đơn sàn về là đã chốt, không có bước xác nhận thủ công như đơn tự tạo
    confirmedOn: order.create_time ? new Date(order.create_time * 1000) : null,
    paidOn,
    deliveredOn: order.delivery_time
      ? new Date(order.delivery_time * 1000)
      : null,
    createdOn: order.create_time
      ? new Date(order.create_time * 1000)
      : new Date(),

    subTotalPrice: toDecimal(p.sub_total),
    totalDiscounts: toDecimal(p.seller_discount).add(
      toDecimal(p.platform_discount),
    ),
    totalTax: toDecimal(p.tax),
    totalShippingPrice: toDecimal(p.shipping_fee),
    totalPrice,
    totalReceived: paidOn ? totalPrice : new Prisma.Decimal(0),
    currency: p.currency ?? 'VND',
    gateway: order.payment_method_name ?? null,
    shippingMethod:
      order.delivery_option_name ?? order.shipping_provider ?? null,
    ...mapRecipientAddress(order),
    note: order.buyer_message?.trim() || null,
    email: order.buyer_email ?? null,
  } satisfies Prisma.OrderUncheckedUpdateInput & Record<string, unknown>;
}

/**
 * Địa chỉ người nhận → các cột `shipping_*`.
 *
 * Dữ liệu này **bị che một phần** và vẫn ghi nguyên phần che: tên `đ** đ** q***g`, SĐT
 * `0947****98`, số nhà `Ph********************` — nhưng tỉnh/quận thì thật. Ghi vào còn
 * hơn để trống như trước: nhân viên CSKH cần biết đơn đi tỉnh nào, và 4 số cuối SĐT đủ để
 * đối chiếu khi khách gọi lên. Xem `TiktokOrder.recipient_address` về vì sao bị che.
 *
 * Cấp hành chính đọc theo `address_level` (`L0`..`L3`), **không** theo `address_level_name`:
 * trường tên cấp trả về không nhất quán trên dữ liệu thật — cùng là L2 mà đơn này ghi
 * `district` ("Tiên Lãng"), đơn kia ghi `city` ("Phường Hai Bà Trưng") sau đợt gộp đơn vị
 * hành chính. Mã `L0..L3` thì luôn đúng thứ tự nước → tỉnh → quận/huyện → phường/xã.
 *
 * Trả về `{}` khi TikTok không đưa gì (đơn đang giữ — `is_on_hold_order` — trả object
 * rỗng). Phải là `{}` chứ không phải một loạt `null`: `upsertOrder()` dùng chung object
 * này cho nhánh `update`, ghi `null` đè lên sẽ xoá mất địa chỉ đã lấy được ở lần đồng bộ
 * trước mỗi khi đơn chuyển sang trạng thái bị che.
 */
export function mapRecipientAddress(
  order: TiktokOrder,
): Partial<ShippingAddressFields> {
  const a = order.recipient_address;
  if (!a) return {};

  const level = (code: string) =>
    a.district_info?.find((d) => d.address_level === code);
  const country = level('L0');
  const province = level('L1');
  const district = level('L2');
  const ward = level('L3');

  const fields: ShippingAddressFields = {
    shippingName: clean(a.name),
    shippingPhone: normalizePhone(a.phone_number),
    // `address_detail` là bản dài nhất — đo được nó chính là `address_line1` ghép
    // `address_line2`, nên lấy một mình nó là đủ, không cần đổ sang `shipping_address2`.
    shippingAddress1: clean(a.address_detail) ?? clean(a.address_line1),
    shippingWard: clean(ward?.address_name),
    shippingDistrict: clean(district?.address_name),
    shippingProvince: clean(province?.address_name),
    shippingProvinceCode: clean(province?.iso_code),
    shippingCountry: clean(country?.address_name),
    shippingCountryCode: clean(a.region_code),
  };

  // Không có lấy một trường nào = đơn bị giữ, để nguyên dữ liệu cũ
  return Object.values(fields).some((v) => v !== null) ? fields : {};
}

/** Các cột `orders.shipping_*` mà TikTok là nguồn. Khai riêng để `mapRecipientAddress()`
 *  trả `Partial<>` — nhánh "không có gì" trả `{}` nhưng vẫn giữ được kiểu của từng cột. */
type ShippingAddressFields = {
  shippingName: string | null;
  shippingPhone: string | null;
  shippingAddress1: string | null;
  shippingWard: string | null;
  shippingDistrict: string | null;
  shippingProvince: string | null;
  shippingProvinceCode: string | null;
  shippingCountry: string | null;
  shippingCountryCode: string | null;
};

function clean(v?: string | null): string | null {
  return v?.trim() || null;
}

/**
 * `(+84)947****98` → `0947****98`, cho khớp định dạng SĐT của 16k đơn TikTok cũ về qua
 * Sapo (`036*****68`) để cột SĐT trên màn đơn hàng không lẫn hai kiểu.
 *
 * Phần sau `(+84)` KHÔNG nhất quán: có số đã sẵn số 0 đầu (`(+84)096*****31`), có số thì
 * không (`(+84)947****98`). Cứ thêm `0` sẽ ra `0096*****31`.
 */
function normalizePhone(v?: string | null): string | null {
  const raw = clean(v);
  if (!raw?.startsWith('(+84)')) return raw;
  const local = raw.slice(5).trim();
  return local.startsWith('0') ? local : `0${local}`;
}

/**
 * TikTok: AWAITING_SHIPMENT | AWAITING_COLLECTION | IN_TRANSIT | DELIVERED | COMPLETED |
 * CANCELLED. Nội bộ chỉ có open/closed/cancelled — `COMPLETED` (hết hạn đổi trả, tiền đã
 * về) mới là đóng đơn; `DELIVERED` vẫn còn cửa sổ hoàn nên giữ mở.
 */
function mapStatus(status?: string): OrderStatus {
  if (status === 'CANCELLED') return OrderStatus.cancelled;
  if (status === 'COMPLETED') return OrderStatus.closed;
  return OrderStatus.open;
}

/** Hàng đã rời kho (đang giao trở đi) coi như đã giao xong về mặt xử lý đơn. */
function mapFulfillment(status?: string): OrderFulfillmentStatus | null {
  if (
    status === 'IN_TRANSIT' ||
    status === 'DELIVERED' ||
    status === 'COMPLETED'
  ) {
    return OrderFulfillmentStatus.fulfilled;
  }
  return null;
}

/**
 * Vận đơn cho đơn sàn. TikTok tự chỉ định hãng và tự sinh mã vận đơn, mình chỉ chép lại —
 * khác hẳn đơn tự đẩy sang GHN/ViettelPost (ở đó mình gọi API tạo vận đơn và có
 * `provider_id`).
 *
 * Theo quy ước sẵn có của dự án cho đơn sàn: `delivery_method = 'ecommerce'`,
 * `provider_id` để NULL (hãng không phải đối tác tích hợp trong app), tên hãng thật nằm ở
 * `carrier_name` để `carrierDisplayName()` đọc được.
 *
 * Trả null khi TikTok chưa tạo kiện — đơn mới đặt chưa có mã vận đơn thì không nên dựng
 * sẵn một vận đơn rỗng, vì màn Vận chuyển sẽ hiện đầy dòng trắng không thao tác được.
 */
function mapFulfillmentRecord(
  order: TiktokOrder,
  locationId: bigint,
  createdById: bigint,
) {
  const packageId = order.packages?.[0]?.id;
  // `|| null` chứ không `?? null`: đơn huỷ trả `tracking_number` là chuỗi RỖNG chứ không
  // phải thiếu trường, `??` sẽ để nguyên '' và cột mã vận đơn hiện ô trắng khó hiểu.
  const tracking = order.tracking_number?.trim() || null;
  if (!packageId && !tracking) return null;

  const shipmentStatus = mapShipmentStatus(order.status);
  const at = (unix?: number) => (unix ? new Date(unix * 1000) : null);

  return {
    // Tiền tố để không đụng dải mã vận đơn nội bộ (FUN...) lẫn của Sapo
    name: `TTS-${packageId ?? tracking}`,
    status: order.status === 'CANCELLED' ? 'cancelled' : 'success',
    shipmentStatus,
    deliveryMethod: FulfillmentDeliveryMethod.ecommerce,
    // Sàn đã đóng gói xong mới sinh được mã vận đơn
    packedStatus: PackingStatus.packed,
    trackingNumber: tracking,
    carrierName: order.shipping_provider?.trim() || null,
    trackingCompany: order.delivery_option_name?.trim() || null,
    locationId,
    createdById,
    // `rts_time` = sẵn sàng giao, `collection_time` = hãng đã lấy hàng
    shipmentCreatedOn: at(order.rts_time),
    pickedUpAt: at(order.collection_time),
    deliveredOn: at(order.delivery_time),
    cancelledOn: order.status === 'CANCELLED' ? at(order.update_time) : null,
    codAmount: order.is_cod
      ? toDecimal(order.payment?.total_amount)
      : new Prisma.Decimal(0),
    // Đếm theo `line_items` của TikTok (mỗi phần tử là 1 đơn vị hàng), KHÔNG theo dòng đã
    // ghi được vào đơn: kiện hàng thật vẫn chứa cả món có SKU chưa khớp, đếm theo dòng khớp
    // sẽ ra 0 ở những đơn toàn SKU lạ và làm vận đơn trông như rỗng hàng.
    totalQuantity: order.line_items?.length ?? 0,
  };
}

/**
 * Trạng thái TikTok → `shipment_status` nội bộ. `AWAITING_SHIPMENT` và
 * `AWAITING_COLLECTION` đều là "hãng chưa cầm hàng" nên cùng về `pending` ("Chờ lấy hàng").
 */
function mapShipmentStatus(status?: string): ShipmentStatus | null {
  switch (status) {
    case 'AWAITING_SHIPMENT':
    case 'AWAITING_COLLECTION':
      return ShipmentStatus.pending;
    case 'IN_TRANSIT':
      return ShipmentStatus.delivering;
    case 'DELIVERED':
    case 'COMPLETED':
      return ShipmentStatus.delivered;
    case 'CANCELLED':
      return ShipmentStatus.cancelled;
    default:
      return null;
  }
}

function toDecimal(v?: string | null): Prisma.Decimal {
  if (!v) return new Prisma.Decimal(0);
  const n = new Prisma.Decimal(v);
  return n.isNaN() ? new Prisma.Decimal(0) : n;
}

/** Mặc định 7 ngày gần nhất. Mốc ngày hiểu theo giờ Việt Nam (UTC+7), không phải UTC. */
function resolveRange(from?: string, to?: string) {
  const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
  const now = new Date();
  const toExclusive = to
    ? new Date(
        new Date(`${to}T00:00:00.000Z`).getTime() -
          VN_OFFSET_MS +
          24 * 3600 * 1000,
      )
    : new Date(now.getTime() + 1000);
  const fromDate = from
    ? new Date(new Date(`${from}T00:00:00.000Z`).getTime() - VN_OFFSET_MS)
    : new Date(toExclusive.getTime() - 7 * 24 * 3600 * 1000);

  return {
    from: fromDate,
    toExclusive,
    timeGe: Math.floor(fromDate.getTime() / 1000),
    timeLt: Math.floor(toExclusive.getTime() / 1000),
  };
}
