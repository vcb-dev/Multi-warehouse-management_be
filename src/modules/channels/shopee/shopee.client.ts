import { createHmac } from 'crypto';
import { Logger } from '@nestjs/common';
import { BusinessException } from '../../../common/exceptions/business.exception';

const PRODUCTION_HOST = 'https://partner.shopeemobile.com';
const SANDBOX_HOST = 'https://openplatform.sandbox.test-stable.shopee.sg';

export type ShopeeTokenResult = {
  access_token: string;
  refresh_token: string;
  expire_in: number;
  refresh_token_expire_in?: number;
  shop_id?: number;
};

export type ShopeeOrderListEntry = {
  order_sn: string;
  order_status?: string;
};

export type ShopeeOrderItem = {
  item_name?: string;
  item_sku?: string;
  model_sku?: string;
  model_name?: string;
  model_quantity_purchased?: number;
  model_original_price?: number;
  model_discounted_price?: number;
};

export type ShopeeRecipientAddress = {
  name?: string;
  phone?: string;
  full_address?: string;
  city?: string;
  district?: string;
  state?: string;
  region?: string;
  town?: string;
  zipcode?: string;
};

export type ShopeeOrderDetail = {
  order_sn: string;
  order_status?: string;
  create_time?: number;
  update_time?: number;
  currency?: string;
  cod?: boolean;
  total_amount?: number;
  estimated_shipping_fee?: number;
  actual_shipping_fee?: number;
  shipping_carrier?: string;
  payment_method?: string;
  message_to_seller?: string;
  buyer_user_id?: number;
  buyer_username?: string;
  recipient_address?: ShopeeRecipientAddress;
  item_list?: ShopeeOrderItem[];
};

type ShopeeApiEnvelope<T = unknown> = {
  error?: string;
  message?: string;
  request_id?: string;
  response?: T;
  access_token?: string;
  refresh_token?: string;
  expire_in?: number;
  refresh_token_expire_in?: number;
  shop_name?: string;
};

const ORDER_DETAIL_FIELDS =
  'buyer_user_id,buyer_username,estimated_shipping_fee,recipient_address,item_list,payment_method,total_amount,shipping_carrier,message_to_seller';

/** Public API — partner_id + path + timestamp */
/**
 * Tạo signature cho public API
 */
export function shopeeSignPublic(
  partnerId: string,
  path: string,
  timestamp: number,
  partnerKey: string,
): string {
  const base = `${partnerId}${path}${timestamp}`;
  return createHmac('sha256', partnerKey).update(base).digest('hex');
}

/** Shop API — partner_id + path + timestamp + access_token + shop_id */
/**
 * Tạo signature cho shop API
 */
export function shopeeSignShop(
  partnerId: string,
  path: string,
  timestamp: number,
  accessToken: string,
  shopId: string,
  partnerKey: string,
): string {
  const base = `${partnerId}${path}${timestamp}${accessToken}${shopId}`;
  return createHmac('sha256', partnerKey).update(base).digest('hex');
}

/**
 * Xử lý host Shopee (production hoặc sandbox)
 */
export function resolveShopeeHost(): string {
  const explicit = process.env.SHOPEE_HOST?.trim();
  if (explicit) return explicit.replace(/\/$/, '');

  const env = (process.env.SHOPEE_ENV ?? 'production').trim().toLowerCase();
  if (env === 'sandbox' || env === 'test' || env === 'dev') {
    return SANDBOX_HOST;
  }
  return PRODUCTION_HOST;
}

/**
 * Client HTTP Shopee Open Platform v2 — Authorization overview (open.shopee.com).
 * Dùng `fetch` + HMAC-SHA256 có sẵn, cùng pattern `TiktokClient` / `GhnClient`.
 * Các API Shopee Open Platform v2: https://open.shopee.com/documents/v2/index.html
 */
export class ShopeeClient {
  private readonly logger = new Logger(ShopeeClient.name);
  private readonly host = resolveShopeeHost();

  constructor(
    private readonly partnerId: string,
    private readonly partnerKey: string,
    private readonly redirectUrl: string,
  ) {}
  /**
   * Xây dựng URL để đăng nhập Shopee
   * https://open.shopee.com/documents/v2/auth.html#section/Authentication/Get-authorization-code
   */
  buildAuthorizeUrl(): string {
    const path = '/api/v2/shop/auth_partner';
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = shopeeSignPublic(
      this.partnerId,
      path,
      timestamp,
      this.partnerKey,
    );
    const url = new URL(`${this.host}${path}`);
    url.searchParams.set('partner_id', this.partnerId);
    url.searchParams.set('timestamp', String(timestamp));
    url.searchParams.set('sign', sign);
    url.searchParams.set('redirect', this.redirectUrl);
    return url.toString();
  }

  /**
   * Hoán đổi token Shopee
   * https://open.shopee.com/documents/v2/auth.html#section/Authentication/Get-access-token
   * @param code - Mã code từ Shopee
   * @param shopId - ID của shop Shopee
   * @returns Promise<ShopeeTokenResult> - Kết quả hoán đổi token Shopee
   */
  exchangeToken(code: string, shopId: string): Promise<ShopeeTokenResult> {
    const path = '/api/v2/auth/token/get';
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = shopeeSignPublic(
      this.partnerId,
      path,
      timestamp,
      this.partnerKey,
    );
    const url = new URL(`${this.host}${path}`);
    url.searchParams.set('partner_id', this.partnerId);
    url.searchParams.set('timestamp', String(timestamp));
    url.searchParams.set('sign', sign);

    return this.postJson<ShopeeApiEnvelope>(url.toString(), {
      code,
      shop_id: Number(shopId),
      partner_id: Number(this.partnerId),
    }).then((raw) => this.parseToken(raw, shopId));
  }

  /**
   * Làm mới token Shopee
   * https://open.shopee.com/documents/v2/auth.html#section/Authentication/Get-access-token
   * @param refreshToken - Token refresh từ Shopee
   * @param shopId - ID của shop Shopee
   * @returns Promise<ShopeeTokenResult> - Kết quả làm mới token Shopee
   */
  refreshAccessToken(
    refreshToken: string,
    shopId: string,
  ): Promise<ShopeeTokenResult> {
    const path = '/api/v2/auth/access_token/get';
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = shopeeSignPublic(
      this.partnerId,
      path,
      timestamp,
      this.partnerKey,
    );
    const url = new URL(`${this.host}${path}`);
    url.searchParams.set('partner_id', this.partnerId);
    url.searchParams.set('timestamp', String(timestamp));
    url.searchParams.set('sign', sign);

    return this.postJson<ShopeeApiEnvelope>(url.toString(), {
      shop_id: Number(shopId),
      refresh_token: refreshToken,
      partner_id: Number(this.partnerId),
    }).then((raw) => this.parseToken(raw, shopId));
  }

  /**
   * Lấy tên shop Shopee
   * https://open.shopee.com/documents/v2/shop.html#section/Shop-Info/Get-shop-info
   * @param accessToken - Token access từ Shopee
   * @param shopId - ID của shop Shopee
   * @returns Promise<string | null> - Tên shop Shopee
   */
  getShopName(accessToken: string, shopId: string): Promise<string | null> {
    const path = '/api/v2/shop/get_shop_info';
    return this.shopGet<{ shop_name?: string }>(path, accessToken, shopId)
      .then((data) => data.shop_name ?? null)
      .catch(() => null);
  }

  /**
   * Danh sách đơn theo khoảng thời gian — mỗi request tối đa 15 ngày.
   * https://open.shopee.com/documents/v2/v2.order.get_order_list
   */
  getOrderList(
    accessToken: string,
    shopId: string,
    params: {
      timeRangeField: 'create_time' | 'update_time';
      timeFrom: number;
      timeTo: number;
      pageSize?: number;
      cursor?: string;
      orderStatus?: string;
    },
  ): Promise<{
    order_list: ShopeeOrderListEntry[];
    more: boolean;
    next_cursor?: string;
  }> {
    const path = '/api/v2/order/get_order_list';
    const query: Record<string, string> = {
      time_range_field: params.timeRangeField,
      time_from: String(params.timeFrom),
      time_to: String(params.timeTo),
      page_size: String(params.pageSize ?? 50),
      response_optional_fields: 'order_status',
      cursor: params.cursor ?? '',
    };
    if (params.orderStatus) query.order_status = params.orderStatus;

    return this.shopGet(path, accessToken, shopId, query);
  }

  /**
   * Chi tiết đơn (tối đa 50 order_sn mỗi lần).
   * https://open.shopee.com/documents/v2/v2.order.get_order_detail
   */
  getOrderDetail(
    accessToken: string,
    shopId: string,
    orderSnList: string[],
  ): Promise<{ order_list: ShopeeOrderDetail[] }> {
    const path = '/api/v2/order/get_order_detail';
    return this.shopGet(path, accessToken, shopId, {
      order_sn_list: orderSnList.join(','),
      response_optional_fields: ORDER_DETAIL_FIELDS,
    });
  }

  private shopGet<T>(
    path: string,
    accessToken: string,
    shopId: string,
    query: Record<string, string> = {},
  ): Promise<T> {
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = shopeeSignShop(
      this.partnerId,
      path,
      timestamp,
      accessToken,
      shopId,
      this.partnerKey,
    );
    const url = new URL(`${this.host}${path}`);
    url.searchParams.set('partner_id', this.partnerId);
    url.searchParams.set('timestamp', String(timestamp));
    url.searchParams.set('sign', sign);
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set('shop_id', shopId);
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
    return this.getJson<ShopeeApiEnvelope<T>>(url.toString()).then((raw) =>
      this.unwrapShopResponse(raw, path),
    );
  }

  private unwrapShopResponse<T>(raw: ShopeeApiEnvelope<T>, path: string): T {
    if (raw.error) {
      const msg = raw.message ?? raw.error;
      this.logger.warn(`Shopee ${path}: ${msg}`);
      throw new BusinessException('CHANNEL_API_ERROR', `Shopee: ${msg}`, 422);
    }
    if (raw.response !== undefined) return raw.response;
    return raw as T;
  }

  /**
   * Phân tích kết quả hoán đổi token Shopee
   * @param raw - Kết quả hoán đổi token Shopee
   * @param shopId - ID của shop Shopee
   * @returns ShopeeTokenResult - Kết quả hoán đổi token Shopee
   */
  private parseToken(
    raw: ShopeeApiEnvelope,
    shopId: string,
  ): ShopeeTokenResult {
    if (
      raw.error ||
      !raw.access_token ||
      !raw.refresh_token ||
      !raw.expire_in
    ) {
      const msg = raw.message ?? raw.error ?? 'Shopee không trả token';
      throw new BusinessException('CHANNEL_AUTH_ERROR', `Shopee: ${msg}`, 422);
    }
    return {
      access_token: raw.access_token,
      refresh_token: raw.refresh_token,
      expire_in: raw.expire_in,
      refresh_token_expire_in: raw.refresh_token_expire_in,
      shop_id: Number(shopId),
    };
  }

  /**
   * Gửi POST request đến Shopee
   * @param url - URL đến Shopee
   * @param body - Body của request
   * @returns Promise<T> - Kết quả của request
   */
  private async postJson<T>(
    url: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      this.logger.error(`Shopee POST không gọi được: ${String(e)}`);
      throw new BusinessException(
        'CHANNEL_UNAVAILABLE',
        'Không kết nối được tới Shopee, vui lòng thử lại',
        502,
      );
    }
    const raw = (await res.json().catch(() => null)) as T | null;
    if (!res.ok || !raw) {
      throw new BusinessException(
        'CHANNEL_AUTH_ERROR',
        `Shopee trả về HTTP ${res.status}`,
        422,
      );
    }
    return raw;
  }

  private async getJson<T>(url: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      this.logger.error(`Shopee GET không gọi được: ${String(e)}`);
      throw new BusinessException(
        'CHANNEL_UNAVAILABLE',
        'Không kết nối được tới Shopee, vui lòng thử lại',
        502,
      );
    }
    const raw = (await res.json().catch(() => null)) as T | null;
    if (!res.ok || !raw) {
      throw new BusinessException(
        'CHANNEL_AUTH_ERROR',
        `Shopee trả về HTTP ${res.status}`,
        422,
      );
    }
    return raw;
  }
}
