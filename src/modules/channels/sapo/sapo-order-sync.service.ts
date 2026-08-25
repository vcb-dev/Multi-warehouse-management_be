import { Injectable, Logger } from '@nestjs/common';
import {
  InventoryBucket,
  MovementType,
  NotificationTopic,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { BusinessException } from '../../../common/exceptions/business.exception';
import { InventoryService } from '../../inventory/inventory.service';
import { sortForLocking } from '../../inventory/inventory.types';
import { NotificationService } from '../../notifications/notification.service';
import { SapoClient } from '../../products/sapo-sync/sapo-client';
import { normalizeChannelShopName } from '../channel-order-link';
import { resolveChannelSyncActorId } from '../channel-sync-actor';

/**
 * Kéo đơn mới từ Sapo vào bảng `orders` theo nhịp cron.
 *
 * Vì sao có file này: trước đây TikTok và Shopee đã có cron trong
 * `channel-sync.scheduler.ts`, còn đơn Sapo chỉ về DB khi có người chạy tay
 * `scripts/sync-new-sapo-orders.ts` — nghĩa là đơn tạo trên Sapo (POS, web, đơn chat
 * OmniAI, các sàn Sapo còn giữ kết nối) nằm im cho tới lượt chạy tay tiếp theo. Logic ở
 * đây port nguyên từ script đó, giữ đúng các quyết định đã chốt trên dữ liệu thật:
 *
 * 1. **Chỉ TẠO đơn mới, không cập nhật đơn đã có.** Đơn đã có `sapo_id` trong DB bị bỏ
 *    qua. Cập nhật trạng thái đơn cũ là bài toán khác (`scripts/refresh-order-statuses.js`)
 *    và cần chính sách riêng về việc ghi đè trạng thái nội bộ — không gộp vào đây.
 *
 * 2. **Đơn còn mở thì giữ chỗ tồn (`order_reserve` → bucket `committed`).** Đơn
 *    `closed`/`fulfilled` thì KHÔNG: hàng đã rời kho trước khi app biết tới đơn, reserve
 *    lúc này tạo giữ chỗ "ma" vĩnh viễn vì không còn bước ĐTVC lấy hàng nào chạy để giải
 *    phóng. Đây là chỗ khác với đường TikTok/Shopee (hai kênh đó không đụng tồn vì sàn đã
 *    trừ kho phía sàn) — khác biệt có chủ đích, không phải bỏ sót.
 *
 * 3. **SKU lạ thì bỏ dòng, không bỏ đơn**, và ghi vết vào `channel_sku_gaps` với
 *    `channel = 'sapo'` để màn Kênh bán chỉ ra đang thiếu phiên bản nào — thay vì nuốt im
 *    lặng như script cũ (script chỉ đếm rồi in ra console, chạy xong là mất).
 */

/** Mirror của MOVEMENT_TX_OPTIONS trong inventory.service.ts (không export). */
const ORDER_TX_OPTIONS = { maxWait: 15_000, timeout: 30_000 };

/** Sapo trả tối đa 250 bản ghi mỗi trang. */
const PAGE_SIZE = 250;

/**
 * Trần số trang mỗi lượt chạy. Cron 15 phút không bao giờ chạm tới; đây là chặn để một
 * lượt chạy tay với `since` rất xa không kéo vô hạn và chiếm connection pool hàng giờ.
 */
const MAX_PAGES = Number(process.env.SAPO_ORDER_SYNC_MAX_PAGES ?? 40);

/**
 * Lùi mốc quét lại vài phút so với đơn Sapo mới nhất đang có. Đơn về trễ (Sapo ghi nhận
 * xong mới lộ ra ở API) sẽ bị bỏ sót nếu quét khít mép; quét trùng thì vô hại vì bước
 * kiểm `sapo_id` đã lọc.
 */
const OVERLAP_MINUTES = Number(
  process.env.SAPO_ORDER_SYNC_OVERLAP_MINUTES ?? 60,
);

/** Không có đơn Sapo nào trong DB (cài mới) thì quét lùi ngần này giờ, không quét cả lịch sử. */
const COLD_START_HOURS = Number(
  process.env.SAPO_ORDER_SYNC_COLD_START_HOURS ?? 24,
);

/**
 * Cùng biến với TikTok/Shopee — đơn đặt quá lâu thì tạo vẫn tạo, chỉ không bắn thông báo.
 * Không có chặn này thì một lượt chạy tay với mốc xa sẽ dội hàng nghìn thông báo về đơn cũ.
 */
const SYNC_NOTIFY_MAX_AGE_HOURS = Number(
  process.env.SYNC_NOTIFY_MAX_AGE_HOURS ?? 24,
);

const STATUS = ['open', 'closed', 'cancelled'];
const FIN = [
  'pending',
  'partially_paid',
  'paid',
  'refunded',
  'partially_refunded',
];
const FUL = ['partial', 'fulfilled'];
const RET = ['no_return', 'in_progress', 'returned'];
const REF = ['no_refund', 'refunded', 'partial'];
const RESTOCK = ['no_restock', 'restocked', 'partial'];

type SapoLineItem = {
  variant_id?: number | string | null;
  product_id?: number | string | null;
  inventory_item_id?: number | string | null;
  name?: string | null;
  title?: string | null;
  variant_title?: string | null;
  sku?: string | null;
  quantity?: number | null;
  price?: number | string | null;
  total_discount?: number | string | null;
  discounted_total?: number | string | null;
  original_total?: number | string | null;
  fulfillable_quantity?: number | null;
  current_quantity?: number | null;
  non_fulfillable_quantity?: number | null;
  refundable_quantity?: number | null;
  grams?: number | null;
  taxable?: boolean | null;
  requires_shipping?: boolean | null;
  restockable?: boolean | null;
};

type SapoOrder = Record<string, any> & {
  id: number | string;
  name?: string | null;
  line_items?: SapoLineItem[];
};

export interface SapoOrderSyncResult {
  /** Mốc `created_on_min` đã dùng để hỏi Sapo. */
  since: string;
  fetched: number;
  created: number;
  lines: number;
  reserved: number;
  skipped_existing: number;
  skipped_lines_no_variant: number;
  failed: number;
  /**
   * Đơn về từ kho Sapo không có trong `locations` — vẫn tạo, nhưng gán tạm kho mặc định.
   * Có số khác 0 ở đây là dấu hiệu thiếu kho, phải chạy đồng bộ kho rồi sửa lại các đơn đó.
   */
  orders_unknown_location: number;
  /** `location_id` phía Sapo của những đơn nói trên, để tra thẳng bên Sapo. */
  unknown_sapo_location_ids: string[];
}

type SkuGap = {
  sku: string;
  productName: string | null;
  variantName: string | null;
  lineCount: number;
  quantity: number;
  amount: number;
  lastSeenAt: Date;
};

const toDate = (v: unknown): Date | null => (v ? new Date(v as string) : null);

const enumOr = <T extends string>(
  v: unknown,
  allowed: readonly string[],
  fallback: T,
): T => (allowed.includes(v as string) ? (v as T) : fallback);

@Injectable()
export class SapoOrderSyncService {
  private readonly logger = new Logger(SapoOrderSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sapo: SapoClient,
    private readonly inventory: InventoryService,
    private readonly notifications: NotificationService,
  ) {}

  isConfigured(): boolean {
    return this.sapo.isConfigured();
  }

  /**
   * @param sinceIso Mốc `created_on_min`. Bỏ trống = tự suy từ đơn Sapo mới nhất trong DB
   *                 (lùi `OVERLAP_MINUTES`), hoặc `COLD_START_HOURS` nếu DB chưa có đơn nào.
   */
  async syncNewOrders(sinceIso?: string): Promise<SapoOrderSyncResult> {
    if (!this.sapo.isConfigured()) {
      throw new BusinessException(
        'CHANNEL_NOT_CONFIGURED',
        'Thiếu SAPO_STORE/SAPO_API_KEY/SAPO_API_SECRET trong cấu hình server',
        500,
      );
    }

    const [actorId, defaultLocation] = await Promise.all([
      resolveChannelSyncActorId(this.prisma),
      this.prisma.location.findFirst({
        orderBy: { id: 'asc' },
        select: { id: true },
      }),
    ]);
    if (!actorId) {
      throw new BusinessException(
        'CHANNEL_SYNC_ACTOR_MISSING',
        'Không tìm thấy user đồng bộ (CHANNEL_SYNC_ACTOR_* hoặc admin active)',
        500,
      );
    }
    if (!defaultLocation) {
      throw new BusinessException(
        'LOCATION_MISSING',
        'DB chưa có chi nhánh nào để gán cho đơn đồng bộ',
        500,
      );
    }

    const since = sinceIso ?? (await this.resolveSince());
    const result: SapoOrderSyncResult = {
      since,
      fetched: 0,
      created: 0,
      lines: 0,
      reserved: 0,
      skipped_existing: 0,
      skipped_lines_no_variant: 0,
      failed: 0,
      orders_unknown_location: 0,
      unknown_sapo_location_ids: [],
    };
    const gaps = new Map<string, SkuGap>();
    const unknownLocations = new Set<string>();

    for (let page = 1; page <= MAX_PAGES; page++) {
      const qs = new URLSearchParams({
        limit: String(PAGE_SIZE),
        page: String(page),
        created_on_min: since,
      });
      const body = await this.sapo.get<{ orders?: SapoOrder[] }>(
        `/admin/orders.json?${qs.toString()}`,
      );
      const orders = body.orders ?? [];
      if (!orders.length) break;
      result.fetched += orders.length;

      await this.processPage(orders, {
        actorId,
        defaultLocationId: defaultLocation.id,
        gaps,
        unknownLocations,
        result,
      });

      if (orders.length < PAGE_SIZE) break;
      if (page === MAX_PAGES) {
        this.logger.warn(
          `Đồng bộ đơn Sapo: chạm trần ${MAX_PAGES} trang — còn đơn chưa kéo, chạy lại hoặc nới SAPO_ORDER_SYNC_MAX_PAGES`,
        );
      }
    }

    await this.recordSkuGaps(gaps);

    result.unknown_sapo_location_ids = [...unknownLocations];
    if (unknownLocations.size) {
      // Cảnh báo to, không im lặng: đơn đã bị gán sai kho, và mọi báo cáo theo kho từ giờ
      // sẽ lệch cho tới khi kho được thêm và các đơn đó được gán lại.
      this.logger.warn(
        `Đồng bộ đơn Sapo: ${result.orders_unknown_location} đơn về từ kho CHƯA CÓ trong ` +
          `\`locations\` (Sapo location_id: ${[...unknownLocations].join(', ')}) — đã tạm gán ` +
          'kho mặc định. Chạy POST channels/sapo/location-sync rồi sửa lại kho cho các đơn này.',
      );
    }
    return result;
  }

  /** Mốc quét mặc định: đơn Sapo mới nhất trong DB, lùi lại `OVERLAP_MINUTES`. */
  private async resolveSince(): Promise<string> {
    const last = await this.prisma.order.findFirst({
      where: { sapoId: { not: null } },
      orderBy: { createdOn: 'desc' },
      select: { createdOn: true },
    });
    const base = last
      ? last.createdOn.getTime() - OVERLAP_MINUTES * 60_000
      : Date.now() - COLD_START_HOURS * 3_600_000;
    return new Date(base).toISOString();
  }

  private async processPage(
    orders: SapoOrder[],
    ctx: {
      actorId: bigint;
      defaultLocationId: bigint;
      gaps: Map<string, SkuGap>;
      unknownLocations: Set<string>;
      result: SapoOrderSyncResult;
    },
  ) {
    // Tra cứu theo lô của đúng trang này thay vì nạp toàn bộ variant/customer/order như
    // script cũ: cron chạy 15 phút một lần, nạp 30k đơn + hàng chục nghìn phiên bản mỗi
    // lượt chỉ để đối chiếu vài đơn là lãng phí connection lẫn RAM.
    const sapoIds = orders.map((o) => BigInt(o.id));
    const variantSapoIds = [
      ...new Set(
        orders.flatMap((o) =>
          (o.line_items ?? [])
            .map((l) => l.variant_id)
            .filter((v): v is number | string => v != null)
            .map((v) => BigInt(v)),
        ),
      ),
    ];
    const customerSapoIds = [
      ...new Set(
        orders
          .map((o) => o.customer?.id)
          .filter((v): v is number | string => v != null)
          .map((v) => BigInt(v)),
      ),
    ];
    const locationSapoIds = [
      ...new Set(
        orders
          .map((o) => o.location_id)
          .filter((v): v is number | string => v != null)
          .map((v) => BigInt(v)),
      ),
    ];
    const candidateNames = orders.map((o) => String(o.name ?? o.id));

    const [existing, variants, customers, locations, usedNames] =
      await Promise.all([
        this.prisma.order.findMany({
          where: { sapoId: { in: sapoIds } },
          select: { sapoId: true },
        }),
        this.prisma.productVariant.findMany({
          where: { sapoId: { in: variantSapoIds } },
          select: { id: true, sapoId: true },
        }),
        this.prisma.customer.findMany({
          where: { sapoId: { in: customerSapoIds } },
          select: { id: true, sapoId: true },
        }),
        this.prisma.location.findMany({
          where: { sapoId: { in: locationSapoIds } },
          select: { id: true, sapoId: true },
        }),
        this.prisma.order.findMany({
          where: { name: { in: candidateNames } },
          select: { name: true },
        }),
      ]);

    const existingSapoIds = new Set(existing.map((o) => String(o.sapoId)));
    const varBySapo = new Map(variants.map((v) => [String(v.sapoId), v.id]));
    const cusBySapo = new Map(customers.map((c) => [String(c.sapoId), c.id]));
    const locBySapo = new Map(locations.map((l) => [String(l.sapoId), l.id]));
    const takenNames = new Set(usedNames.map((o) => o.name));

    for (const o of orders) {
      if (existingSapoIds.has(String(o.id))) {
        ctx.result.skipped_existing += 1;
        continue;
      }

      // `orders.name` là UNIQUE — đơn trùng mã (đơn tạo tại app dùng dải mã riêng nhưng
      // vẫn có thể đụng) thì thêm hậu tố id để không vỡ ràng buộc thay vì mất đơn.
      let name = String(o.name ?? o.id);
      if (takenNames.has(name)) name = `${name}-${o.id}`;

      const items: Prisma.OrderItemCreateWithoutOrderInput[] = [];
      for (const l of o.line_items ?? []) {
        const variantId = varBySapo.get(String(l.variant_id));
        if (!variantId) {
          ctx.result.skipped_lines_no_variant += 1;
          this.collectGap(ctx.gaps, l, toDate(o.created_on) ?? new Date());
          continue;
        }
        items.push({
          variant: { connect: { id: variantId } },
          productId: l.product_id ? BigInt(l.product_id) : null,
          inventoryItemId: l.inventory_item_id
            ? BigInt(l.inventory_item_id)
            : null,
          name: l.name || l.title || '',
          variantTitle: l.variant_title || null,
          sku: l.sku || '',
          quantity: l.quantity ?? 0,
          price: String(l.price ?? 0),
          totalDiscount: String(l.total_discount ?? 0),
          discountedTotal: String(l.discounted_total ?? 0),
          originalTotal:
            l.original_total != null ? String(l.original_total) : null,
          fulfillableQuantity: l.fulfillable_quantity ?? null,
          currentQuantity: l.current_quantity ?? null,
          nonFulfillableQuantity: l.non_fulfillable_quantity ?? null,
          refundableQuantity: l.refundable_quantity ?? null,
          grams: l.grams ?? null,
          taxable: l.taxable ?? true,
          requiresShipping: l.requires_shipping ?? true,
          restockable: l.restockable ?? true,
        });
      }
      // Đơn không còn dòng nào khớp phiên bản: bỏ hẳn. Ghi đơn rỗng thì tổng tiền vẫn vào
      // báo cáo nhưng không truy được bán cái gì — vết đã nằm ở `channel_sku_gaps`.
      if (!items.length) continue;

      const status = enumOr(o.status, STATUS, 'open');
      const fulfillmentStatus = FUL.includes(o.fulfillment_status)
        ? (o.fulfillment_status as 'partial' | 'fulfilled')
        : null;
      // Kho lạ: vẫn tạo đơn (bỏ đơn còn tệ hơn — mất luôn doanh số) nhưng ghi vết để lượt
      // chạy báo lại, thay vì lặng lẽ dồn vào kho mặc định như bản đầu.
      const mappedLocationId = locBySapo.get(String(o.location_id));
      if (!mappedLocationId) {
        ctx.unknownLocations.add(String(o.location_id ?? 'null'));
        ctx.result.orders_unknown_location += 1;
      }
      const locationId = mappedLocationId ?? ctx.defaultLocationId;
      const data = this.buildOrderData(o, {
        name,
        status,
        fulfillmentStatus,
        locationId,
        customerId: cusBySapo.get(String(o.customer?.id)) ?? null,
        actorId: ctx.actorId,
        items,
      });

      try {
        const record = await this.prisma.$transaction(async (tx) => {
          const created = await tx.order.create({ data });
          if (this.shouldReserve(status, fulfillmentStatus)) {
            await this.reserveStock(tx, created.id, items, {
              locationId,
              actorId: ctx.actorId,
            });
          }
          return created;
        }, ORDER_TX_OPTIONS);

        ctx.result.created += 1;
        ctx.result.lines += items.length;
        if (this.shouldReserve(status, fulfillmentStatus)) {
          ctx.result.reserved += 1;
        }
        existingSapoIds.add(String(o.id));
        takenNames.add(name);
        this.notifyNewOrder(record.id, name, data, locationId);
      } catch (e) {
        ctx.result.failed += 1;
        this.logger.warn(
          `Đồng bộ đơn Sapo ${name}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`,
        );
      }
    }
  }

  /** Đơn nào được phép giữ chỗ committed — hàng chưa/chỉ mới một phần rời kho. */
  private shouldReserve(status: string, fulfillmentStatus: string | null) {
    return status === 'open' && fulfillmentStatus !== 'fulfilled';
  }

  private async reserveStock(
    tx: Prisma.TransactionClient,
    orderId: bigint,
    items: Prisma.OrderItemCreateWithoutOrderInput[],
    ctx: { locationId: bigint; actorId: bigint },
  ) {
    const rows = items
      .filter((i) => (i.quantity ?? 0) > 0)
      .map((i) => ({
        variantId: (i.variant as { connect: { id: bigint } }).connect.id,
        locationId: ctx.locationId,
        quantity: i.quantity as number,
      }));

    // sortForLocking: khoá row theo thứ tự cố định để hai lượt sync chạy song song không
    // ôm khoá chéo nhau rồi deadlock.
    for (const row of sortForLocking(rows)) {
      await this.inventory.applyMovement(
        {
          variantId: row.variantId,
          locationId: ctx.locationId,
          bucket: InventoryBucket.committed,
          change: row.quantity,
          type: MovementType.order_reserve,
          referenceType: 'order',
          referenceId: orderId,
          createdById: ctx.actorId,
        },
        tx,
      );
    }
  }

  private buildOrderData(
    o: SapoOrder,
    ctx: {
      name: string;
      status: string;
      fulfillmentStatus: 'partial' | 'fulfilled' | null;
      locationId: bigint;
      customerId: bigint | null;
      actorId: bigint;
      items: Prisma.OrderItemCreateWithoutOrderInput[];
    },
  ): Prisma.OrderCreateInput {
    const sa = o.shipping_address ?? {};
    return {
      sapoId: BigInt(o.id),
      name: ctx.name,
      number: o.number ?? null,
      orderNumber: o.order_number ?? null,
      location: { connect: { id: ctx.locationId } },
      ...(ctx.customerId
        ? { customer: { connect: { id: ctx.customerId } } }
        : {}),
      createdBy: { connect: { id: ctx.actorId } },
      sourceName: o.source_name || null,
      // "Mã tham chiếu" + link đơn gốc Sapo trả sẵn. Với đơn chat (facebook/zalo-oa/
      // tiktok-for-business) `source_identifier` là conversationId của Chat OmniAI —
      // không suy ra được từ `name`, nên đây là đường duy nhất lấy được.
      sourceIdentifier: o.source_identifier || null,
      sourceUrl: o.source_url || null,
      channelShopId: o.channel_definition?.branch_external_id
        ? String(o.channel_definition.branch_external_id)
        : null,
      // Cắt đuôi kênh Sapo gắn thêm ("Viễn Chí Bảo - Tiktokshop") để khớp tên trần mà sync
      // trực tiếp từ sàn ghi — không chuẩn hoá thì cùng một gian ra hai dòng trên UI.
      channelShopName: normalizeChannelShopName(
        o.source_name,
        o.channel_definition?.branch_name,
      ),
      status: enumOr(ctx.status, STATUS, 'open'),
      financialStatus: enumOr(o.financial_status, FIN, 'pending'),
      fulfillmentStatus: ctx.fulfillmentStatus,
      returnStatus: enumOr(o.return_status, RET, 'no_return'),
      refundStatus: enumOr(o.refund_status, REF, 'no_refund'),
      // Khác script cũ: script truyền null khi giá trị lạ, nhưng cột là NOT NULL nên đơn
      // đó văng lỗi và bị đếm vào `failed`. Rơi về 'no_restock' đúng như default của cột.
      restockStatus: enumOr(o.restock_status, RESTOCK, 'no_restock'),
      issueStatus: o.issue_status || null,
      email: o.email || null,
      phone: o.phone || sa.phone || null,
      subTotalPrice: String(o.sub_total_price ?? 0),
      totalDiscounts: String(o.total_discounts ?? 0),
      totalTax: String(o.total_tax ?? 0),
      totalShippingPrice: String(o.total_shipping_price ?? 0),
      totalPrice: String(o.total_price ?? 0),
      subtotalLineItemsQuantity: o.subtotal_line_items_quantity ?? 0,
      totalReceived: String(o.total_received ?? 0),
      currency: o.currency || 'VND',
      gateway: o.gateway || null,
      totalWeight: o.total_weight ?? null,
      unpaidAmount: o.unpaid_amount != null ? String(o.unpaid_amount) : null,
      totalOutstanding:
        o.total_outstanding != null ? String(o.total_outstanding) : null,
      totalRefunded: o.total_refunded != null ? String(o.total_refunded) : null,
      note: o.note || null,
      tags: o.tags
        ? String(o.tags)
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
      createdOn: toDate(o.created_on) ?? new Date(),
      cancelledOn: toDate(o.cancelled_on),
      cancelReason: o.cancel_reason || null,
      closedOn: toDate(o.closed_on),
      completedOn: toDate(o.completed_on),
      paidOn: toDate(o.paid_on),
      processedOn: toDate(o.processed_on),
      deliveredOn: toDate(o.delivered_on),
      expectedDeliveryDate: toDate(o.expected_delivery_date),
      shippingName: sa.name || null,
      shippingFirstName: sa.first_name || null,
      shippingLastName: sa.last_name || null,
      shippingPhone: sa.phone || null,
      shippingAddress1: sa.address1 || null,
      shippingAddress2: sa.address2 || null,
      shippingWard: sa.ward || null,
      shippingWardCode: sa.ward_code || null,
      shippingDistrict: sa.district || null,
      shippingDistrictCode: sa.district_code || null,
      shippingProvince: sa.province || null,
      shippingProvinceCode: sa.province_code || null,
      shippingCity: sa.city || null,
      shippingCountry: sa.country || null,
      shippingCountryCode: sa.country_code || null,
      shippingZip: sa.zip || null,
      items: { create: ctx.items },
    };
  }

  /** Gọi NGOÀI transaction — không giữ lock đơn, và tx rollback không để lại thông báo ma. */
  private notifyNewOrder(
    orderId: bigint,
    name: string,
    data: Prisma.OrderCreateInput,
    locationId: bigint,
  ) {
    const placedAt = data.createdOn ? new Date(data.createdOn as Date) : null;
    if (!placedAt) return;
    const ageHours = (Date.now() - placedAt.getTime()) / 3_600_000;
    if (ageHours > SYNC_NOTIFY_MAX_AGE_HOURS) return;

    void this.notifications.emit(NotificationTopic.orders_create, {
      subjectType: 'order',
      subjectId: orderId,
      locationId,
      title: `Đơn hàng mới ${name}`,
      payload: {
        code: name,
        total_price: Number(data.totalPrice ?? 0),
        source_name: data.sourceName ?? null,
      },
    });
  }

  private collectGap(
    gaps: Map<string, SkuGap>,
    line: SapoLineItem,
    seenAt: Date,
  ) {
    // Dòng không có SKU thì không gom được vào đâu (khoá của bảng là (channel, sku)) —
    // bỏ qua thay vì tạo một dòng rác khoá rỗng nuốt mọi dòng lỗi khác nhau.
    const sku = line.sku?.trim();
    if (!sku) return;

    const prev = gaps.get(sku);
    const quantity = line.quantity ?? 0;
    const amount = Number(line.discounted_total ?? line.price ?? 0);
    gaps.set(sku, {
      sku,
      productName: line.name || line.title || prev?.productName || null,
      variantName: line.variant_title || prev?.variantName || null,
      lineCount: (prev?.lineCount ?? 0) + 1,
      quantity: (prev?.quantity ?? 0) + quantity,
      amount: (prev?.amount ?? 0) + amount,
      lastSeenAt: prev && prev.lastSeenAt > seenAt ? prev.lastSeenAt : seenAt,
    });
  }

  /**
   * Cộng dồn SKU chưa khớp vào `channel_sku_gaps`.
   *
   * Khác TikTok/Shopee (ghi đè vì mỗi lượt quét lại trọn khoảng): ở đây mỗi lượt chỉ nhìn
   * đơn MỚI chưa từng vào DB, nên cộng dồn mới ra đúng tổng tích luỹ.
   */
  private async recordSkuGaps(gaps: Map<string, SkuGap>) {
    for (const gap of gaps.values()) {
      await this.prisma.channelSkuGap.upsert({
        where: { channel_sku: { channel: 'sapo', sku: gap.sku } },
        create: {
          channel: 'sapo',
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
          lineCount: { increment: gap.lineCount },
          quantity: { increment: gap.quantity },
          amount: { increment: gap.amount },
          lastSeenAt: gap.lastSeenAt,
        },
      });
    }
  }
}
