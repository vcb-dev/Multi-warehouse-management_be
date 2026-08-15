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

const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 3000;

/** Mã lỗi TikTok đáng thử lại — xem ghi chú ở `call()`. */
const RETRYABLE_TIKTOK_CODES = new Set([
  105005, // Access denied — TikTok trả nhầm khi scope vừa bật xong
  105002, // Rate limit
]);

/** Giữ `code` gốc của TikTok để tầng retry phân biệt lỗi tạm thời với lỗi cấu hình. */
export class TiktokApiError extends BusinessException {
  constructor(
    code: string,
    message: string,
    statusCode: number,
    public readonly tiktokCode: number | null,
  ) {
    super(code, message, statusCode);
  }
}

function isRetryable(e: unknown): boolean {
  if (!(e instanceof TiktokApiError)) return false;
  // Lỗi mạng (`tiktokCode` null) luôn đáng thử lại
  return e.tiktokCode === null || RETRYABLE_TIKTOK_CODES.has(e.tiktokCode);
}

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

/**
 * Một đơn vị hàng, KHÔNG phải một "dòng" gộp số lượng: TikTok trả mỗi sản phẩm mua n cái
 * thành n phần tử `line_items` riêng (mỗi phần tử có `id` khác nhau), và **không có trường
 * `quantity`**. Muốn ra số lượng phải tự gom theo `sku_id` — kiểm chứng trên dữ liệu thật
 * 2026-08-15: 639 đơn / 711 phần tử, có 2 đơn mua trùng SKU 2 cái.
 */
export type TiktokOrderLine = {
  id: string;
  product_id?: string;
  product_name?: string;
  sku_id?: string;
  /** SKU do người bán tự đặt — đây là chỗ khớp với `product_variants.sku` bên này. */
  seller_sku?: string;
  sku_name?: string;
  /** Giá niêm yết trước giảm giá, cho 1 đơn vị. */
  original_price?: string;
  /** Giá thực trả sau giảm giá, cho 1 đơn vị. Hàng tặng (`is_gift`) có giá 0. */
  sale_price?: string;
  seller_discount?: string;
  platform_discount?: string;
  currency?: string;
  display_status?: string;
  is_gift?: boolean;
  sku_image?: string;
  package_id?: string;
  tracking_number?: string;
  shipping_provider_name?: string;
};

/** `status` quan sát được trên dữ liệu thật: AWAITING_SHIPMENT, AWAITING_COLLECTION, IN_TRANSIT, DELIVERED, COMPLETED, CANCELLED. */
export type TiktokOrder = {
  id: string;
  status?: string;
  create_time?: number;
  update_time?: number;
  paid_time?: number;
  delivery_time?: number;
  collection_time?: number;
  rts_time?: number;
  cancel_reason?: string;
  buyer_email?: string;
  buyer_message?: string;
  is_cod?: boolean;
  payment_method_name?: string;
  delivery_option_name?: string;
  /** Tên hãng vận chuyển do TikTok chỉ định — quan sát thực tế: 'J&T Express', 'GHN'. */
  shipping_provider?: string;
  tracking_number?: string;
  /** Kiện hàng. Đo 2026-08-15: 0/100 đơn có nhiều hơn 1 kiện, nhưng TikTok vẫn trả mảng. */
  packages?: { id?: string }[];
  payment?: {
    currency?: string;
    total_amount?: string;
    sub_total?: string;
    shipping_fee?: string;
    original_shipping_fee?: string;
    original_total_product_price?: string;
    seller_discount?: string;
    platform_discount?: string;
    tax?: string;
  };
  /**
   * CẢNH BÁO: TikTok che toàn bộ thông tin người nhận với app chỉ có `seller.order.info` —
   * mọi trường về rỗng chuỗi (kiểm chứng 2026-08-15), không phải lỗi parse. Muốn có tên/
   * SĐT/địa chỉ thật phải xin thêm quyền PII bên Partner Center.
   */
  recipient_address?: {
    name?: string;
    first_name?: string;
    last_name?: string;
    phone_number?: string;
    full_address?: string;
    address_detail?: string;
    address_line1?: string;
    postal_code?: string;
    region_code?: string;
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
   * Đơn trong một khoảng thời gian. TikTok phân trang bằng `next_page_token` chứ không
   * phải số trang.
   *
   * Chọn lọc theo `create_time` hay `update_time` là quyết định quan trọng, không phải
   * chi tiết vụn: đơn TikTok đổi trạng thái rất lâu sau khi tạo (đo 2026-08-15: 182 đơn
   * đổi trạng thái trong 24h, tất cả đều tạo từ 16/07). Quét định kỳ mà lọc theo
   * `create_time` sẽ không bao giờ thấy các thay đổi đó — cron phải dùng `update_time`.
   */
  searchOrders(params: {
    shopCipher: string;
    /** Unix giây. Lọc theo `create_time` — dùng khi lấy đơn mới của một khoảng ngày. */
    createTimeGe?: number;
    createTimeLt?: number;
    /** Unix giây. Lọc theo `update_time` — dùng cho quét định kỳ để bắt cả đơn cũ đổi trạng thái. */
    updateTimeGe?: number;
    updateTimeLt?: number;
    pageSize?: number;
    pageToken?: string;
  }): Promise<{
    orders?: TiktokOrder[];
    next_page_token?: string;
    total_count?: number;
  }> {
    const query: Record<string, string> = {
      shop_cipher: params.shopCipher,
      page_size: String(params.pageSize ?? 50),
    };
    if (params.pageToken) query.page_token = params.pageToken;

    const body: Record<string, unknown> = {};
    if (params.createTimeGe != null) body.create_time_ge = params.createTimeGe;
    if (params.createTimeLt != null) body.create_time_lt = params.createTimeLt;
    if (params.updateTimeGe != null) body.update_time_ge = params.updateTimeGe;
    if (params.updateTimeLt != null) body.update_time_lt = params.updateTimeLt;

    return this.call(
      'POST',
      `/order/${API_VERSION}/orders/search`,
      query,
      body,
    );
  }

  /**
   * Chi tiết đơn. Thực đo 2026-08-15: `searchOrders` trả về ĐÚNG bộ field như endpoint này
   * (chỉ thiếu `payment_method_code`), kể cả `payment` và `line_items` đầy đủ — nên luồng
   * đồng bộ KHÔNG cần gọi thêm hàm này, tránh 600+ lời gọi thừa mỗi lần chạy.
   */
  getOrderDetail(
    shopCipher: string,
    ids: string[],
  ): Promise<{ orders?: TiktokOrder[] }> {
    return this.call('GET', `/order/${API_VERSION}/orders`, {
      shop_cipher: shopCipher,
      ids: ids.join(','),
    });
  }

  /**
   * TikTok trả `105005` (Access denied) một cách ngẫu nhiên ngay cả khi scope đã bật đủ —
   * đo được ngày 2026-08-15: trong cùng một lần phân trang, trang 1 và trang 3 lỗi rồi
   * thử lại 3 giây sau là qua, các trang khác bình thường. Vì vậy 105005 KHÔNG được coi là
   * lỗi cấu hình vĩnh viễn; thử lại vài lần rồi mới bỏ cuộc. Lỗi mạng cũng đi cùng đường này.
   */
  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    query: Record<string, string> = {},
    body?: unknown,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.callOnce<T>(method, path, query, body);
      } catch (e) {
        lastError = e;
        if (!isRetryable(e) || attempt === MAX_ATTEMPTS) throw e;
        const waitMs = attempt * RETRY_BASE_MS;
        this.logger.warn(
          `TikTok ${method} ${path} lỗi tạm thời (lần ${attempt}/${MAX_ATTEMPTS}), thử lại sau ${waitMs}ms`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    throw lastError;
  }

  private async callOnce<T>(
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
      this.logger.error(
        `TikTok ${method} ${path} không gọi được: ${String(e)}`,
      );
      throw new TiktokApiError(
        'CHANNEL_UNAVAILABLE',
        'Không kết nối được tới TikTok Shop, vui lòng thử lại',
        502,
        null,
      );
    }

    const raw = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (!res.ok || !raw || raw.code !== 0) {
      const msg = raw?.message ?? `TikTok trả về HTTP ${res.status}`;
      this.logger.warn(
        `TikTok ${method} ${path} lỗi (code=${raw?.code}): ${msg}`,
      );
      throw new TiktokApiError(
        'CHANNEL_API_ERROR',
        `TikTok Shop: ${msg}`,
        422,
        raw?.code ?? null,
      );
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
  private sign(
    path: string,
    params: Record<string, string>,
    body: string,
  ): string {
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
