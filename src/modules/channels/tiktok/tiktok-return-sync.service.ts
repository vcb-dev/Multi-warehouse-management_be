import { Injectable, Logger } from '@nestjs/common';
import {
  OrderRefundStatus,
  OrderReturnStatus,
  Prisma,
} from '@prisma/client';
import { BusinessException } from '../../../common/exceptions/business.exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { TiktokApiClient, TiktokReturn } from './tiktok-api.client';
import { TiktokAuthService } from './tiktok-auth.service';

/**
 * Kéo phiếu hoàn/trả TikTok về `orders.return_status` / `orders.refund_status` và bảng
 * `order_returns`.
 *
 * Vì sao cần riêng một service: luồng đơn hàng (`TiktokOrderSyncService`) KHÔNG hề đụng
 * tới hai cột này — hệ quả đo được ngày 18/08 là **1.273 đơn TikTok kẹt
 * `in_progress` + `no_refund` vĩnh viễn**, cái mới nhất từ tháng 3, vì nguồn Sapo đứt từ
 * 03/08 và không có gì chốt chúng lại. API hoàn hàng nằm ở nhóm endpoint khác
 * (`/return_refund/...`, scope `seller.return_refund.basic`) nên phải gọi tách.
 *
 * **Cố ý KHÔNG ghi `order_refunds` và `orders.total_refunded`.** Đó là sổ tiền, đang có
 * sẵn dữ liệu từ Sapo (434 đơn `returned`+`refunded`, kèm phiếu hoàn tiền thật); chèn thêm
 * bản ghi từ TikTok mà không đối chiếu được với bản ghi Sapo sẽ thổi số tiền hoàn lên gấp
 * đôi trên báo cáo. Ở đây chỉ chốt TRẠNG THÁI, phần hạch toán để làm sau khi đã có cách
 * khớp hai nguồn.
 */
@Injectable()
export class TiktokReturnSyncService {
  private readonly logger = new Logger(TiktokReturnSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: TiktokAuthService,
  ) {}

  /**
   * Đồng bộ phiếu hoàn theo khoảng ngày.
   *
   * `filterBy` mặc định `updated` chứ không phải `created`: phiếu hoàn sống rất lâu — đo
   * 2026-08-18 thấy phiếu tạo từ tháng 5 vẫn còn ở `AWAITING_BUYER_SHIP`. Lọc theo ngày
   * tạo thì mọi thay đổi trạng thái về sau đều không thấy, đúng cái bẫy đã gặp với đơn.
   */
  async syncReturns(params: {
    from?: string;
    to?: string;
    filterBy?: 'created' | 'updated';
    createdById: bigint;
  }) {
    const { timeGe, timeLt, from, toExclusive } = resolveRange(
      params.from,
      params.to,
    );
    const filterBy = params.filterBy ?? 'updated';

    const client = await this.client();
    const shops = await client.getAuthorizedShops();
    const cipher = shops[0]?.cipher;
    if (!cipher) {
      throw new BusinessException(
        'CHANNEL_AUTH_ERROR',
        'Token TikTok không gắn với gian hàng nào — cần ủy quyền lại',
        422,
      );
    }

    const returns = await this.fetchAll(client, cipher, timeGe, timeLt, filterBy);
    this.logger.log(
      `TikTok trả về ${returns.length} phiếu hoàn (lọc theo ${filterBy})`,
    );

    const result = await this.apply(returns, params.createdById);
    return {
      from,
      to: new Date(toExclusive.getTime() - 1000),
      filter_by: filterBy,
      fetched: returns.length,
      ...result,
    };
  }

  /** Quét cửa sổ ngắn vừa qua theo `update_time` — dành cho cron. */
  async syncRecent(windowMinutes: number, createdById: bigint) {
    const now = Math.floor(Date.now() / 1000);
    const client = await this.client();
    const shops = await client.getAuthorizedShops();
    const cipher = shops[0]?.cipher;
    if (!cipher) return { fetched: 0, orders_updated: 0, returns_saved: 0, unmatched_orders: 0 };

    const returns = await this.fetchAll(
      client,
      cipher,
      now - windowMinutes * 60,
      now,
      'updated',
    );
    const result = await this.apply(returns, createdById);
    return { fetched: returns.length, ...result };
  }

  private async client() {
    const conn = await this.prisma.channelConnection.findFirst({
      where: { channel: 'tiktok' },
      orderBy: { createdAt: 'desc' },
    });
    if (!conn) {
      throw new BusinessException(
        'CHANNEL_NOT_CONFIGURED',
        'Chưa kết nối TikTok Shop',
        422,
      );
    }
    const oneDay = 24 * 60 * 60 * 1000;
    const fresh =
      conn.accessTokenExpiresAt.getTime() - Date.now() > oneDay
        ? conn
        : await this.auth.refreshConnection(conn.id);

    return new TiktokApiClient(
      process.env.TIKTOK_APP_KEY!.trim(),
      process.env.TIKTOK_APP_SECRET!.trim(),
      fresh.accessToken,
    );
  }

  private async fetchAll(
    client: TiktokApiClient,
    shopCipher: string,
    timeGe: number,
    timeLt: number,
    filterBy: 'created' | 'updated',
  ): Promise<TiktokReturn[]> {
    const all: TiktokReturn[] = [];
    let pageToken: string | undefined;
    let page = 0;
    const window =
      filterBy === 'updated'
        ? { updateTimeGe: timeGe, updateTimeLt: timeLt }
        : { createTimeGe: timeGe, createTimeLt: timeLt };

    do {
      const res = await client.searchReturns({
        shopCipher,
        ...window,
        pageSize: 50,
        pageToken,
      });
      all.push(...(res.return_orders ?? []));
      pageToken = res.next_page_token || undefined;
      page++;
      // Trần phòng `next_page_token` lặp vô hạn — 200 trang × 50 = 10.000 phiếu
    } while (pageToken && page < 200);

    return all;
  }

  /**
   * Ghi xuống DB. Gom theo đơn TRƯỚC khi ghi: một đơn có thể có nhiều phiếu hoàn (trả từng
   * phần), tính trạng thái theo từng phiếu rồi ghi đè lần lượt sẽ để đơn mang trạng thái
   * của phiếu cuối cùng gặp được — thứ tự TikTok trả về không đảm bảo gì cả.
   */
  private async apply(returns: TiktokReturn[], createdById: bigint) {
    const byOrder = new Map<string, TiktokReturn[]>();
    for (const r of returns) {
      const list = byOrder.get(r.order_id) ?? [];
      list.push(r);
      byOrder.set(r.order_id, list);
    }

    const orders = await this.prisma.order.findMany({
      where: { name: { in: [...byOrder.keys()] } },
      select: { id: true, name: true, totalPrice: true },
    });
    const orderByName = new Map(orders.map((o) => [o.name, o]));

    let ordersUpdated = 0;
    let returnsSaved = 0;

    for (const [orderName, list] of byOrder) {
      const order = orderByName.get(orderName);
      // Đơn chưa có trong DB: bỏ qua chứ không tạo — phiếu hoàn không đủ dữ liệu dựng đơn,
      // và luồng đồng bộ đơn sẽ kéo nó về ở lượt sau rồi lượt hoàn kế tiếp mới khớp được.
      if (!order) continue;

      const summary = summarizeReturns(list, order.totalPrice);
      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          returnStatus: summary.returnStatus,
          refundStatus: summary.refundStatus,
        },
      });
      ordersUpdated++;

      for (const r of list) {
        // `code` unique nên upsert là idempotent — quét trùng khoảng không sinh phiếu ma
        await this.prisma.orderReturn.upsert({
          where: { code: returnCode(r) },
          create: {
            code: returnCode(r),
            orderId: order.id,
            reason: returnReason(r),
            createdById,
            createdOn: r.create_time ? new Date(r.create_time * 1000) : new Date(),
          },
          update: { reason: returnReason(r) },
        });
        returnsSaved++;
      }
    }

    return {
      orders_updated: ordersUpdated,
      returns_saved: returnsSaved,
      unmatched_orders: byOrder.size - ordersUpdated,
    };
  }
}

/** Tiền tố để không đụng dải mã phiếu hoàn nội bộ lẫn của Sapo. */
function returnCode(r: TiktokReturn) {
  return `TTR-${r.return_id}`;
}

/** Ưu tiên chuỗi người đọc được; mã máy (`ecom_order_..._no_longer_needed_new`) là lùi. */
function returnReason(r: TiktokReturn): string | null {
  return r.return_reason_text?.trim() || r.return_reason?.trim() || null;
}

/**
 * Gộp nhiều phiếu hoàn của cùng một đơn thành cặp trạng thái của đơn.
 *
 * Ba quy ước, đều chốt từ dữ liệu thật (563 phiếu, 2026-08-18):
 *
 * 1. **Còn phiếu đang mở thì đơn là `in_progress`**, bất kể có phiếu nào đã xong chưa —
 *    hàng vẫn đang trên đường về thì chưa chốt được.
 * 2. **`RETURN_OR_REFUND_REQUEST_CANCEL` KHÔNG phải là hoàn thành công** mà là yêu cầu bị
 *    huỷ (96/563 phiếu). Coi nó là "xong" sẽ báo hoàn cho gần một phần sáu số phiếu mà
 *    thực tế khách vẫn giữ hàng.
 * 3. **`return_type = REFUND` (3/563) là hoàn tiền KHÔNG trả hàng** → `refund_status` có
 *    đổi nhưng `return_status` phải giữ `no_return`, vì không có hàng nào về kho.
 */
export function summarizeReturns(
  returns: TiktokReturn[],
  orderTotal: Prisma.Decimal,
): { returnStatus: OrderReturnStatus; refundStatus: OrderRefundStatus } {
  let anyPending = false;
  let anyGoodsReturned = false;
  let refunded = new Prisma.Decimal(0);

  for (const r of returns) {
    const state = classify(r.return_status);
    if (state === 'pending') {
      anyPending = true;
      continue;
    }
    if (state === 'dropped') continue;

    // Từ đây là phiếu đã hoàn tất
    if (r.return_type !== 'REFUND') anyGoodsReturned = true;
    refunded = refunded.add(toDecimal(r.refund_amount?.refund_total));
  }

  const returnStatus = anyPending
    ? OrderReturnStatus.in_progress
    : anyGoodsReturned
      ? OrderReturnStatus.returned
      : OrderReturnStatus.no_return;

  let refundStatus: OrderRefundStatus = OrderRefundStatus.no_refund;
  if (refunded.gt(0)) {
    // `gte` chứ không `eq`: phí ship hoàn kèm có thể đẩy số hoàn vượt tiền hàng
    refundStatus = refunded.gte(orderTotal)
      ? OrderRefundStatus.refunded
      : OrderRefundStatus.partial;
  }

  return { returnStatus, refundStatus };
}

/**
 * `pending` = đang xử lý · `done` = đã hoàn tất · `dropped` = yêu cầu bị huỷ/từ chối.
 *
 * Mặc định là `pending` chứ không phải `done`: TikTok còn nhiều trạng thái chưa gặp trong
 * mẫu, và đoán nhầm một trạng thái lạ thành "đã hoàn" là báo sai tiền; đoán nhầm thành
 * "đang xử lý" thì cùng lắm là chốt muộn một nhịp quét.
 */
function classify(status?: string): 'pending' | 'done' | 'dropped' {
  switch (status) {
    case 'RETURN_OR_REFUND_REQUEST_COMPLETE':
    case 'RETURN_OR_REFUND_REQUEST_SUCCESS':
      return 'done';
    case 'RETURN_OR_REFUND_REQUEST_CANCEL':
    case 'RETURN_OR_REFUND_REQUEST_REJECT':
      return 'dropped';
    default:
      return 'pending';
  }
}

function toDecimal(v?: string | null): Prisma.Decimal {
  if (!v) return new Prisma.Decimal(0);
  const n = new Prisma.Decimal(v);
  return n.isNaN() ? new Prisma.Decimal(0) : n;
}

/** Mặc định 7 ngày gần nhất, mốc ngày theo giờ Việt Nam — giống `syncOrders`. */
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
