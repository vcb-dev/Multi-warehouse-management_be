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

type ShopeeApiEnvelope = {
  error?: string;
  message?: string;
  request_id?: string;
  access_token?: string;
  refresh_token?: string;
  expire_in?: number;
  refresh_token_expire_in?: number;
  shop_name?: string;
};

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

    return this.getJson<ShopeeApiEnvelope & { shop_name?: string }>(
      url.toString(),
    ).then((raw) => {
      if (raw.error) {
        this.logger.warn(`Shopee get_shop_info: ${raw.message ?? raw.error}`);
        return null;
      }
      return raw.shop_name ?? null;
    });
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
