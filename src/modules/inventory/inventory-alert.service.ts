import { Injectable, Logger } from '@nestjs/common';
import { NotificationTopic } from '@prisma/client';
import { NotificationService } from '../notifications/notification.service';
import { PrismaService } from '../../prisma/prisma.service';
import { parseDateRange } from '../../common/query/filter-params';
import { PENDING_ORDER_WHERE, computeStockReady } from '../orders/order-stock';
import { InventoryNxtService } from './inventory-nxt.service';

/**
 * `enrich()` được thiết kế cho MỘT TRANG kết quả (nó nạp kèm danh mục, NCC, bán
 * 15/30/90 ngày cho từng dòng). Quét cả kho phải chia mẻ, nếu không câu
 * `productCategory.findMany({ where: { productId: { in: [...] } } })` bên trong nó sẽ
 * nhận vài nghìn id một lúc.
 */
const ENRICH_BATCH = 500;

/**
 * Số SKU tối đa nhét vào link `?variantIds=...` của thông báo.
 *
 * Đặt 300 chứ không phải 100: đo trên dữ liệu thật (17/08/2026) kho nhiều nhất có 148
 * SKU âm kho, cắt ở 100 sẽ khiến banner trên màn Tồn kho ghi "100 sản phẩm" trong khi
 * thông báo vừa đọc ghi 148 — người dùng tưởng mất dữ liệu. 300 id ≈ 1.900 ký tự URL,
 * vẫn thừa an toàn với mọi trình duyệt. Giữ ngưỡng để phòng trường hợp bất thường.
 */
const MAX_LINKED_VARIANTS = 300;

/** Số SKU hiển thị ngay trong nội dung thông báo (xem nhanh khỏi bấm). */
const MAX_PREVIEW_ITEMS = 10;

/**
 * Chỉ cảnh báo thiếu hàng cho đơn đặt trong ngần này ngày.
 *
 * KHÔNG phải để giảm tải, mà vì `status='open' AND fulfillment_status IS NULL` vẫn còn lẫn
 * rất nhiều đơn Sapo cũ đã giao xong nhưng không bao giờ được đóng. Đo 09/09/2026 trên dữ
 * liệu thật, số đơn "thiếu hàng" theo cửa sổ:
 *
 *     3 ngày →    14 đơn, 1 kho        14 ngày →   92 đơn, 5 kho
 *     7 ngày →    16 đơn, 1 kho        30 ngày →  764 đơn, 10 kho (kho nhiều nhất 545)
 *     không giới hạn → 1.996 đơn, kho nhiều nhất 1.244 (đơn cũ nhất từ 29/09/2025)
 *
 * Mốc gãy nằm giữa 14 và 30 ngày — qua đó là rác lịch sử chứ không phải việc phải làm.
 * "Kho X có 1.244 đơn thiếu hàng" thì không ai đi xử lý, đó là một con số để bỏ qua.
 */
const SHORTAGE_MAX_ORDER_AGE_DAYS = Number(
  process.env.SHORTAGE_MAX_ORDER_AGE_DAYS ?? 7,
);

type AlertItem = {
  variantId: bigint;
  sku: string;
  name: string;
  /** low_stock: số cần nhập. negative: số âm (đã đổi dấu dương cho dễ đọc). */
  amount: number;
};

@Injectable()
export class InventoryAlertService {
  private readonly logger = new Logger(InventoryAlertService.name);

  constructor(
    private prisma: PrismaService,
    private nxt: InventoryNxtService,
    private notifications: NotificationService,
  ) {}

  /**
   * Quét toàn bộ kho đang hoạt động, sinh thông báo TỔNG HỢP theo từng kho.
   *
   * Vì sao tổng hợp chứ không phải mỗi SKU một thông báo: đo trên dữ liệu thật
   * (17/08/2026) có 175 dòng cần nhập và 756 dòng âm kho. Bắn lẻ thì nhân thêm số người
   * nhận mỗi kho ⇒ vài nghìn dòng mỗi lần quét, chuông thành vô dụng ngay ngày đầu.
   */
  async scanAll(): Promise<{ locations: number; notifications: number }> {
    // Hỏi trạng thái topic TRƯỚC khi quét: một lượt quét đầy đủ mất ~47s cho 14 kho
    // (phải tính bán 15/30/90 ngày trên bảng orders ~88k dòng). Topic tắt mà vẫn quét
    // rồi để `emit` lặng lẽ bỏ đi là đốt từng đó công hai lần mỗi ngày.
    const [lowStockOn, negativeOn, shortageOn] = await Promise.all([
      this.notifications.isTopicEnabled(NotificationTopic.inventory_low_stock),
      this.notifications.isTopicEnabled(NotificationTopic.inventory_negative),
      this.notifications.isTopicEnabled(NotificationTopic.orders_out_of_stock),
    ]);
    if (!lowStockOn && !negativeOn && !shortageOn) {
      return { locations: 0, notifications: 0 };
    }

    const locations = await this.prisma.location.findMany({
      where: { status: 'active' },
      select: { id: true, name: true },
    });

    let sent = 0;
    for (const loc of locations) {
      try {
        // `scanLowStock` là phần đắt nhất (enrich theo mẻ) — bỏ hẳn khi topic tắt.
        if (lowStockOn && (await this.scanLowStock(loc))) sent++;
        if (negativeOn && (await this.scanNegative(loc))) sent++;
        if (shortageOn && (await this.scanOrderShortage(loc))) sent++;
      } catch (e) {
        // Một kho lỗi không được làm hỏng cả lượt quét.
        this.logger.error(
          `Quét tồn kho ${loc.id} (${loc.name}) thất bại`,
          e instanceof Error ? e.stack : String(e),
        );
      }
    }
    return { locations: locations.length, notifications: sent };
  }

  /**
   * Bỏ qua nếu lần quét trước đã báo ĐÚNG con số này cho đúng kho này mà vẫn còn người
   * chưa đọc.
   *
   * Không có chặn này thì cron 2 lần/ngày sinh digest trùng hệt vĩnh viễn: kho 1 có 405
   * SP âm suốt thì mỗi ngày thêm 2 thông báo y nhau, badge chưa đọc chỉ có tăng và người
   * dùng ngừng nhìn chuông. Con số ĐỔI (405 → 412) mới là tin mới, vẫn báo bình thường.
   */
  private async isDuplicateOfUnread(
    topic: NotificationTopic,
    locationId: bigint,
    count: number,
  ) {
    const last = await this.prisma.notification.findFirst({
      where: { topic, subjectType: 'location', subjectId: locationId },
      orderBy: { id: 'desc' },
      select: {
        payload: true,
        recipients: {
          where: { readOn: null },
          select: { userId: true },
          take: 1,
        },
      },
    });
    if (!last || !last.recipients.length) return false;
    const prev = (last.payload ?? {}) as { count?: unknown };
    return prev.count === count;
  }

  /** Cần nhập hàng — `can_nhap_15 > 0` theo công thức định mức của khách. */
  private async scanLowStock(loc: { id: bigint; name: string }) {
    // Chỉ xét dòng CÓ HÀNG hoặc đang giữ chỗ. Bỏ ~14k dòng `on_hand = 0` — đó là sản
    // phẩm catalog chưa từng nhập, không phải "sắp hết hàng".
    const levels = await this.prisma.inventoryLevel.findMany({
      where: {
        locationId: loc.id,
        OR: [{ onHand: { gt: 0 } }, { committed: { gt: 0 } }],
      },
      select: {
        variantId: true,
        locationId: true,
        onHand: true,
        committed: true,
        variant: {
          select: {
            productId: true,
            sku: true,
            product: { select: { name: true } },
          },
        },
      },
    });
    if (!levels.length) return false;

    const rows = levels.map((l) => ({
      variantId: l.variantId,
      locationId: l.locationId,
      productId: l.variant.productId,
      onHand: l.onHand,
      committed: l.committed,
    }));

    const extras = new Map<string, { can_nhap_15: number }>();
    for (let i = 0; i < rows.length; i += ENRICH_BATCH) {
      const part = await this.nxt.enrich(rows.slice(i, i + ENRICH_BATCH));
      for (const [k, v] of part) extras.set(k, v);
    }

    const items: AlertItem[] = [];
    for (const l of levels) {
      const e = extras.get(`${l.variantId}:${l.locationId}`);
      if (!e || e.can_nhap_15 <= 0) continue;
      items.push({
        variantId: l.variantId,
        sku: l.variant.sku,
        name: l.variant.product.name,
        amount: e.can_nhap_15,
      });
    }
    if (!items.length) return false;

    items.sort((a, b) => b.amount - a.amount);

    if (
      await this.isDuplicateOfUnread(
        NotificationTopic.inventory_low_stock,
        loc.id,
        items.length,
      )
    ) {
      return false;
    }

    await this.notifications.emit(NotificationTopic.inventory_low_stock, {
      subjectType: 'location',
      subjectId: loc.id,
      locationId: loc.id,
      title: `${loc.name}: ${items.length} sản phẩm cần nhập hàng`,
      payload: this.buildPayload(loc, items, 'cần nhập'),
    });
    return true;
  }

  /** Âm kho — `available < 0`, tức đã bán/giữ chỗ nhiều hơn số thực có. */
  private async scanNegative(loc: { id: bigint; name: string }) {
    const levels = await this.prisma.inventoryLevel.findMany({
      where: { locationId: loc.id, available: { lt: 0 } },
      select: {
        variantId: true,
        available: true,
        variant: { select: { sku: true, product: { select: { name: true } } } },
      },
      orderBy: { available: 'asc' },
    });
    if (!levels.length) return false;

    const items: AlertItem[] = levels.map((l) => ({
      variantId: l.variantId,
      sku: l.variant.sku,
      name: l.variant.product.name,
      amount: -l.available, // đổi dấu cho dễ đọc: "thiếu 12" thay vì "-12"
    }));

    if (
      await this.isDuplicateOfUnread(
        NotificationTopic.inventory_negative,
        loc.id,
        items.length,
      )
    ) {
      return false;
    }

    await this.notifications.emit(NotificationTopic.inventory_negative, {
      subjectType: 'location',
      subjectId: loc.id,
      locationId: loc.id,
      title: `${loc.name}: ${items.length} sản phẩm âm kho`,
      payload: {
        ...this.buildPayload(loc, items, 'thiếu'),
        // Âm kho biểu diễn được bằng SQL (`available < 0`) nên link dùng bộ lọc thật
        // thay vì liệt kê id: kho nhiều nhất có 405 dòng âm, nhồi từng đó id vào URL
        // vừa xấu vừa phải cắt bớt ⇒ số trên màn lệch số trên thông báo.
        // `stock_status` được ưu tiên hơn `variant_ids` khi dựng link (xem serializer).
        stock_status: 'negative',
      },
    });
    return true;
  }

  /**
   * Đơn đang chờ xử lý mà kho không đủ hàng để đóng gói.
   *
   * Khác hai cảnh báo trên ở chỗ đối tượng phải xử lý là cái ĐƠN, không phải dòng tồn:
   * người nhận phải đi nhập thêm hoặc điều chuyển từ kho khác cho đủ, rồi mới đóng gói
   * được. Vì vậy topic nằm trong nhóm `orders/` và link trỏ về danh sách đơn.
   *
   * Quy tắc "thiếu hàng" lấy nguyên từ {@link computeStockReady} — cùng hàm mà tab
   * "Thiếu hàng" trên màn Đơn hàng đang dùng. Chép lại quy tắc ở đây thì sớm muộn con số
   * trên thông báo sẽ lệch con số hiện ra khi bấm vào.
   *
   * Giới hạn tuổi đơn theo {@link SHORTAGE_MAX_ORDER_AGE_DAYS} — không có nó thì cảnh báo
   * đầu tiên sẽ ghi "1.244 đơn thiếu hàng" cho một kho.
   */
  private async scanOrderShortage(loc: { id: bigint; name: string }) {
    // Dựng chuỗi ngày TRƯỚC rồi mới suy ra mốc Date từ chính nó: `created_on_min` đi vào
    // link phải cho ra đúng tập đơn vừa đếm. Tự tính `new Date(now - 7 ngày)` cho truy vấn
    // rồi format riêng cho link là hai mốc khác nhau (một cái giữa ngày, một cái đầu ngày
    // theo giờ cửa hàng) — lệch vài đơn là mất niềm tin vào con số trên thông báo.
    const createdOnMin = shortageWindowStart();
    const since = parseDateRange(createdOnMin, undefined)?.gte;

    const orders = await this.prisma.order.findMany({
      where: {
        ...PENDING_ORDER_WHERE,
        locationId: loc.id,
        ...(since ? { createdOn: { gte: since } } : {}),
      },
      select: {
        id: true,
        name: true,
        locationId: true,
        items: { select: { variantId: true, quantity: true } },
      },
      orderBy: { createdOn: 'desc' },
    });
    if (!orders.length) return false;

    const readyMap = await computeStockReady(this.prisma, orders);
    const short = orders.filter((o) => readyMap.get(o.id) === false);
    if (!short.length) return false;

    if (
      await this.isDuplicateOfUnread(
        NotificationTopic.orders_out_of_stock,
        loc.id,
        short.length,
      )
    ) {
      return false;
    }

    await this.notifications.emit(NotificationTopic.orders_out_of_stock, {
      subjectType: 'order_shortage',
      // `subjectId` là id KHO chứ không phải id đơn — đây là digest gom theo kho, giống
      // hai cảnh báo tồn ở trên. Serializer đọc nó để dựng link lọc theo kho.
      subjectId: loc.id,
      locationId: loc.id,
      title: `${loc.name}: ${short.length} đơn thiếu hàng chưa đóng gói được`,
      payload: {
        location_id: loc.id.toString(),
        location_name: loc.name,
        count: short.length,
        // Serializer ghép thẳng vào link — cùng một mốc với truy vấn ở trên.
        created_on_min: createdOnMin,
        preview: short.slice(0, MAX_PREVIEW_ITEMS).map((o) => ({
          order_id: o.id.toString(),
          code: o.name,
        })),
      },
    });
    return true;
  }

  private buildPayload(
    loc: { id: bigint; name: string },
    items: AlertItem[],
    unitLabel: string,
  ) {
    return {
      location_id: loc.id.toString(),
      location_name: loc.name,
      count: items.length,
      unit_label: unitLabel,
      // Dùng để dựng link `/warehouse/inventory?variantIds=...` — màn Tồn kho đã hỗ trợ sẵn
      // filter này, nên bấm vào thông báo là thấy đúng những SKU được đếm, không phải
      // một bộ lọc khác cho ra con số khác.
      variant_ids: items
        .slice(0, MAX_LINKED_VARIANTS)
        .map((i) => i.variantId.toString())
        .join(','),
      truncated: items.length > MAX_LINKED_VARIANTS,
      preview: items.slice(0, MAX_PREVIEW_ITEMS).map((i) => ({
        sku: i.sku,
        name: i.name,
        amount: i.amount,
      })),
    };
  }
}

/**
 * Mốc đầu cửa sổ dạng `YYYY-MM-DD` — đúng định dạng mà `created_on_min` trên URL nhận,
 * nên cùng một chuỗi dùng được cho cả truy vấn lẫn link.
 */
function shortageWindowStart(now: Date = new Date()): string {
  const start = new Date(now.getTime() - SHORTAGE_MAX_ORDER_AGE_DAYS * 864e5);
  return start.toISOString().slice(0, 10);
}
