import { BusinessException } from '../../../common/exceptions/business.exception';
import {
  GhnApiResponse,
  GhnCreateOrderData,
  GhnCreateOrderInput,
  GhnCreateOrderResult,
  GhnCredentials,
} from './ghn.types';

const SANDBOX_BASE_URL = 'https://dev-online-gateway.ghn.vn';
const PRODUCTION_BASE_URL = 'https://online-gateway.ghn.vn';

/**
 * GHN_ENV=sandbox|test → sandbox gateway
 * GHN_ENV=production (mặc định) → production
 * GHN_BASE_URL nếu set sẽ ghi đè GHN_ENV
 */
export function resolveGhnBaseUrl(): string {
  const explicit = process.env.GHN_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');

  const env = (process.env.GHN_ENV ?? 'production').trim().toLowerCase();
  if (env === 'sandbox' || env === 'test' || env === 'dev') {
    return SANDBOX_BASE_URL;
  }
  return PRODUCTION_BASE_URL;
}

export function isGhnSandbox(): boolean {
  return resolveGhnBaseUrl().includes('dev-online-gateway');
}

/**
 * Thin HTTP client for GHN public API.
 * Token/ShopId come from shipping_providers.connection_config per shop.
 */
export class GhnClient {
  constructor(
    private readonly credentials: GhnCredentials,
    private readonly baseUrl: string = resolveGhnBaseUrl(),
  ) {}

  async createOrder(input: GhnCreateOrderInput): Promise<GhnCreateOrderResult> {
    const data = await this.post<GhnCreateOrderData>(
      '/shiip/public-api/v2/shipping-order/create',
      {
        payment_type_id: input.paymentTypeId,
        note: input.note ?? '',
        required_note: input.requiredNote,
        client_order_code: input.clientOrderCode,
        from_name: input.fromName,
        from_phone: input.fromPhone,
        from_address: input.fromAddress,
        from_ward_name: input.fromWardName ?? '',
        from_district_name: input.fromDistrictName ?? '',
        from_province_name: input.fromProvinceName ?? '',
        to_name: input.toName,
        to_phone: input.toPhone,
        to_address: input.toAddress,
        to_ward_name: input.toWardName ?? '',
        to_district_name: input.toDistrictName ?? '',
        to_province_name: input.toProvinceName ?? '',
        cod_amount: Math.max(0, Math.round(input.codAmount)),
        content: input.content ?? '',
        weight: input.weightGrams,
        length: input.lengthCm,
        width: input.widthCm,
        height: input.heightCm,
        insurance_value: Math.min(
          5_000_000,
          Math.max(0, Math.round(input.insuranceValue ?? 0)),
        ),
        service_type_id: input.serviceTypeId ?? 2,
      },
    );

    const totalFee = Number(data.total_fee ?? data.fee?.main_service ?? 0);
    return {
      orderCode: data.order_code,
      totalFee: Number.isFinite(totalFee) ? totalFee : 0,
      expectedDeliveryTime: data.expected_delivery_time ?? null,
      sortCode: data.sort_code ?? null,
    };
  }

  async cancelOrder(orderCodes: string[]): Promise<void> {
    if (!orderCodes.length) return;
    await this.post('/shiip/public-api/v2/switch-status/cancel', {
      order_codes: orderCodes,
    });
  }

  /** Smoke-check credentials (list provinces — chỉ cần Token hợp lệ). */
  async ping(): Promise<void> {
    await this.post('/shiip/public-api/master-data/province', {});
  }

  private async post<T>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, '')}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Token: this.credentials.token,
          ShopId: String(this.credentials.shopId),
          ...(init.headers ?? {}),
        },
      });
    } catch {
      throw new BusinessException(
        'GHN_UNAVAILABLE',
        'Không kết nối được tới GHN. Thử lại sau.',
        502,
      );
    }

    let payload: GhnApiResponse<T>;
    try {
      payload = (await response.json()) as GhnApiResponse<T>;
    } catch {
      throw new BusinessException(
        'GHN_ERROR',
        `GHN trả về phản hồi không hợp lệ (HTTP ${response.status})`,
        502,
      );
    }

    if (!response.ok || payload.code !== 200) {
      const detail =
        payload.message_display || payload.message || 'GHN từ chối yêu cầu';
      const hint = isGhnSandbox()
        ? ' (đang dùng sandbox — Token production cần GHN_ENV=production)'
        : ' (đang dùng production — Token test cần GHN_ENV=sandbox)';
      throw new BusinessException('GHN_ERROR', `${detail}${hint}`, 422);
    }
    return payload.data;
  }
}

export function trackingUrlFor(orderCode: string): string {
  return `https://donhang.ghn.vn/?order_code=${encodeURIComponent(orderCode)}`;
}

export function parseGhnCredentials(config: unknown): GhnCredentials | null {
  if (!config || typeof config !== 'object') return null;
  const raw = config as { token?: unknown; shop_id?: unknown };
  const token = typeof raw.token === 'string' ? raw.token.trim() : '';
  const shopRaw = raw.shop_id;
  const shopId =
    typeof shopRaw === 'number'
      ? shopRaw
      : typeof shopRaw === 'string'
        ? Number(shopRaw.trim())
        : NaN;
  if (!token || !Number.isFinite(shopId) || shopId <= 0) return null;
  return { token, shopId };
}
