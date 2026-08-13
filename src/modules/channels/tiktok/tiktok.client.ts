import { Logger } from '@nestjs/common';
import { BusinessException } from '../../../common/exceptions/business.exception';

const TOKEN_BASE_URL = 'https://auth.tiktok-shops.com/api/v2/token';

type TiktokTokenEnvelope = {
  code: number;
  message: string;
  request_id: string;
  data?: {
    access_token: string;
    /** Unix timestamp (giây) — KHÔNG phải số giây còn lại. */
    access_token_expire_in: number;
    refresh_token: string;
    refresh_token_expire_in: number;
    open_id: string;
    seller_name?: string;
    seller_base_region?: string;
    user_type: number;
    granted_scopes: string[];
  };
};

export type TiktokTokenResult = NonNullable<TiktokTokenEnvelope['data']>;

/**
 * Client HTTP cho TikTok Shop Auth API (Authorization overview, TikTok Shop Partner Center).
 * Dùng `fetch` có sẵn của Node — cùng cách `GhnClient` gọi API ngoài, không thêm dependency.
 */
export class TiktokClient {
  private readonly logger = new Logger(TiktokClient.name);

  constructor(
    private readonly appKey: string,
    private readonly appSecret: string,
  ) {}

  getAccessToken(authCode: string): Promise<TiktokTokenResult> {
    // Lưu ý: grant_type phải đúng chữ "authorized_code" — không phải "authorization_code" chuẩn OAuth.
    return this.callToken('get', {
      auth_code: authCode,
      grant_type: 'authorized_code',
    });
  }

  refreshAccessToken(refreshToken: string): Promise<TiktokTokenResult> {
    return this.callToken('refresh', {
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
  }

  private async callToken(
    action: 'get' | 'refresh',
    params: Record<string, string>,
  ): Promise<TiktokTokenResult> {
    const url = new URL(`${TOKEN_BASE_URL}/${action}`);
    url.searchParams.set('app_key', this.appKey);
    url.searchParams.set('app_secret', this.appSecret);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      this.logger.error(`TikTok token/${action} không gọi được: ${String(e)}`);
      throw new BusinessException(
        'CHANNEL_UNAVAILABLE',
        'Không kết nối được tới TikTok Shop, vui lòng thử lại',
        502,
      );
    }

    const raw = (await res.json().catch(() => null)) as TiktokTokenEnvelope | null;
    if (!res.ok || !raw || raw.code !== 0 || !raw.data) {
      const msg = raw?.message ?? `TikTok trả về HTTP ${res.status}`;
      this.logger.warn(`TikTok token/${action} lỗi: ${msg}`);
      throw new BusinessException('CHANNEL_AUTH_ERROR', `TikTok Shop: ${msg}`, 422);
    }
    return raw.data;
  }
}
