import { Logger } from '@nestjs/common';
import { createHmac } from 'crypto';
import { BusinessException } from '../../../common/exceptions/business.exception';

/**
 * Client cho TikTok Shop Open API (nhóm endpoint nghiệp vụ: shop, đơn hàng).
 *
 * Tách khỏi `TiktokClient` (chỉ lo token) vì hai nhóm này khác nhau cơ bản: endpoint
 * token dùng domain `auth.tiktok-shops.com` và KHÔNG ký request, còn Open API dùng
 * `open-api.tiktokglobalshop.com` và bắt buộc ký HMAC từng lời gọi.
 */

const BASE_URL = 'https://open-api.tiktokglobalshop.com';
/** Phiên bản API nhỏ nhất còn được hỗ trợ cho nhóm order/authorization. */
const API_VERSION = '202309';

type Envelope<T> = {
  code: number;
  message: string;
  request_id: string;
  data?: T;
};

export type TiktokShopInfo = {
  id: string;
  name: string;
  region?: string;
  seller_type?: string;
  /** Bắt buộc phải kèm vào mọi lời gọi API theo shop (trừ nhóm /authorization). */
  cipher: string;
};

export type TiktokOrderLine = {
  id: string;
  product_id?: string;
  product_name?: string;
  sku_id?: string;
  /** SKU do người bán tự đặt — đây là chỗ khớp với `product_variants.sku` bên này. */
  seller_sku?: string;
  sku_name?: string;
  original_price?: string;
  sale_price?: string;
  currency?: string;
  display_status?: string;
};

export type TiktokOrder = {
  id: string;
  status?: string;
  create_time?: number;
  update_time?: number;
  paid_time?: number;
  delivery_time?: number;
  cancel_reason?: string;
  buyer_email?: string;
  buyer_message?: string;
  payment?: {
    currency?: string;
    total_amount?: string;
    sub_total?: string;
    shipping_fee?: string;
    seller_discount?: string;
    platform_discount?: string;
    tax?: string;
  };
  recipient_address?: {
    name?: string;
    phone_number?: string;
    full_address?: string;
    district_info?: { address_name?: string; address_level_name?: string }[];
  };
  line_items?: TiktokOrderLine[];
};

export class TiktokApiClient {
  private readonly logger = new Logger(TiktokApiClient.name);

  constructor(
    private readonly appKey: string,
    private readonly appSecret: string,
    private readonly accessToken: string,
  ) {}

  /**
   * Shop mà access token này được phép thao tác. Phải gọi trước tiên vì các API đơn hàng
   * đều cần `shop_cipher` lấy từ đây — `open_id` lưu lúc ủy quyền KHÔNG thay thế được.
   */
  async getAuthorizedShops(): Promise<TiktokShopInfo[]> {
    const res = await this.call<{ shops: TiktokShopInfo[] }>(
      'GET',
      `/authorization/${API_VERSION}/shops`,
    );
    return res.shops ?? [];
  }

  /**
   * Đơn tạo/cập nhật trong khoảng thời gian. TikTok phân trang bằng `next_page_token`
   * chứ không phải số trang.
   */
  searchOrders(params: {
    shopCipher: string;
    /** Unix giây. Lọc theo `create_time`. */
    createTimeGe?: number;
    createTimeLt?: number;
    pageSize?: number;
    pageToken?: string;
  }): Promise<{ orders?: TiktokOrder[]; next_page_token?: string; total_count?: number }> {
    const query: Record<string, string> = {
      shop_cipher: params.shopCipher,
      page_size: String(params.pageSize ?? 50),
    };
    if (params.pageToken) query.page_token = params.pageToken;

    const body: Record<string, unknown> = {};
    if (params.createTimeGe != null) body.create_time_ge = params.createTimeGe;
    if (params.createTimeLt != null) body.create_time_lt = params.createTimeLt;

    return this.call('POST', `/order/${API_VERSION}/orders/search`, query, body);
  }

  /** Chi tiết đơn (kèm dòng hàng) — `searchOrders` đã trả dòng hàng nhưng không đủ trường tiền. */
  getOrderDetail(shopCipher: string, ids: string[]): Promise<{ orders?: TiktokOrder[] }> {
    return this.call('GET', `/order/${API_VERSION}/orders`, {
      shop_cipher: shopCipher,
      ids: ids.join(','),
    });
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    query: Record<string, string> = {},
    body?: unknown,
  ): Promise<T> {
    // `/authorization/...` không nhận shop_cipher — gửi kèm sẽ bị từ chối
    const params: Record<string, string> = {
      ...query,
      app_key: this.appKey,
      timestamp: String(Math.floor(Date.now() / 1000)),
    };
    if (path.startsWith('/authorization/')) delete params.shop_cipher;

    const payload = body === undefined ? '' : JSON.stringify(body);
    params.sign = this.sign(path, params, method === 'GET' ? '' : payload);

    const url = new URL(BASE_URL + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          'x-tts-access-token': this.accessToken,
          'content-type': 'application/json',
        },
        body: method === 'GET' ? undefined : payload,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      this.logger.error(`TikTok ${method} ${path} không gọi được: ${String(e)}`);
      throw new BusinessException(
        'CHANNEL_UNAVAILABLE',
        'Không kết nối được tới TikTok Shop, vui lòng thử lại',
        502,
      );
    }

    const raw = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (!res.ok || !raw || raw.code !== 0) {
      const msg = raw?.message ?? `TikTok trả về HTTP ${res.status}`;
      this.logger.warn(`TikTok ${method} ${path} lỗi (code=${raw?.code}): ${msg}`);
      throw new BusinessException('CHANNEL_API_ERROR', `TikTok Shop: ${msg}`, 422);
    }
    return (raw.data ?? {}) as T;
  }

  /**
   * Chữ ký theo "Signature algorithm" của TikTok Shop Open API:
   * 1. Bỏ `sign` và `access_token` khỏi query, sắp xếp key theo alphabet.
   * 2. Nối thành `{key}{value}` liền nhau, không dấu phân cách.
   * 3. Ghép đường dẫn API vào ĐẦU chuỗi.
   * 4. Nối body JSON vào cuối (chỉ khi không phải GET / không phải multipart).
   * 5. Bọc app_secret ở cả hai đầu, rồi HMAC-SHA256 với khoá là chính app_secret, hex thường.
   */
  private sign(path: string, params: Record<string, string>, body: string): string {
    const signable = { ...params };
    delete signable.sign;
    delete signable.access_token;

    const joined = Object.keys(signable)
      .sort()
      .map((k) => `${k}${signable[k]}`)
      .join('');

    const base = `${this.appSecret}${path}${joined}${body}${this.appSecret}`;
    return createHmac('sha256', this.appSecret).update(base).digest('hex');
  }
}
