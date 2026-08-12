import { Logger } from '@nestjs/common';
import { BusinessException } from '../../../common/exceptions/business.exception';

const SANDBOX_BASE_URL = 'https://dev-online-gateway.ghn.vn/shiip/public-api';
const PRODUCTION_BASE_URL = 'https://online-gateway.ghn.vn/shiip/public-api';

/**
 * GHN_ENV=sandbox|test → sandbox gateway
 * GHN_ENV=production (mặc định) → production
 * GHN_BASE_URL / GHN_API_BASE_URL nếu set sẽ ghi đè GHN_ENV
 */
export function resolveGhnBaseUrl(): string {
  const explicit =
    process.env.GHN_API_BASE_URL?.trim() || process.env.GHN_BASE_URL?.trim();
  if (explicit) {
    const url = explicit.replace(/\/$/, '');
    return url.includes('/shiip/public-api') ? url : `${url}/shiip/public-api`;
  }

  const env = (process.env.GHN_ENV ?? 'production').trim().toLowerCase();
  if (env === 'sandbox' || env === 'test' || env === 'dev') {
    return SANDBOX_BASE_URL;
  }
  return PRODUCTION_BASE_URL;
}

export function isGhnSandbox(): boolean {
  return resolveGhnBaseUrl().includes('dev-online-gateway');
}

const DEFAULT_BASE_URL = PRODUCTION_BASE_URL;

/** Trang tra cứu vận đơn công khai của GHN — lưu vào Sapo `fulfillments.tracking_url`. */
export const GHN_TRACKING_URL = 'https://donhang.ghn.vn/?order_code=';

export type GhnProvince = {
  ProvinceID: number;
  ProvinceName: string;
  NameExtension?: string[];
};
export type GhnDistrict = {
  DistrictID: number;
  DistrictName: string;
  NameExtension?: string[];
};
export type GhnWard = {
  WardCode: string;
  WardName: string;
  NameExtension?: string[];
};

export type GhnShop = {
  _id: number;
  name: string;
  phone: string;
  address: string;
  ward_code: string;
  district_id: number;
  client_id: number;
};

export type GhnService = {
  service_id: number;
  short_name: string;
  service_type_id: number;
};

export type GhnFeeResult = {
  total: number;
  service_fee?: number;
  insurance_fee?: number;
};

export type GhnCreateOrderPayload = {
  client_order_code?: string;
  to_name: string;
  to_phone: string;
  to_address: string;
  /** GHN create ưu tiên tên — gửi ID đôi khi báo "không lấy được thông tin kho" (đặc biệt sandbox). */
  to_ward_name?: string;
  to_district_name?: string;
  to_province_name?: string;
  to_ward_code?: string;
  to_district_id?: number;
  from_name?: string;
  from_phone?: string;
  from_address?: string;
  from_district_id?: number;
  from_ward_code?: string;
  from_ward_name?: string;
  from_district_name?: string;
  from_province_name?: string;
  return_phone?: string;
  return_address?: string;
  return_district_id?: number | null;
  return_ward_code?: string;
  content?: string;
  cod_amount?: number;
  insurance_value?: number;
  weight: number;
  length: number;
  width: number;
  height: number;
  service_id?: number;
  service_type_id: number;
  payment_type_id: number;
  required_note: string;
  note?: string;
  items: {
    name: string;
    code?: string;
    quantity: number;
    price?: number;
    weight?: number;
  }[];
};

export type GhnCreateOrderResult = {
  order_code: string;
  sort_code?: string;
  trans_type?: string;
  total_fee?: number | string;
  expected_delivery_time?: string;
};

export type GhnCancelResult = {
  order_code: string;
  result: boolean;
  message: string;
};

export type GhnTicket = {
  id: number | string;
  order_code: string;
  type?: string;
  status?: string;
  status_id?: number;
  description?: string;
  attachments?: unknown;
  c_email?: string;
  c_name?: string;
  c_phone?: string | number;
  client_id?: string | number;
  created_by?: number;
  created_at?: string;
  updated_at?: string;
  conversations?: GhnTicketConversation[];
};

export type GhnTicketConversation = {
  body?: string;
  from_email?: string;
  created_at?: string;
  updated_at?: string;
  attachments?: unknown;
};

type GhnEnvelope<T> = {
  code?: number;
  message?: string;
  code_message?: string;
  data?: T;
};

type Credentials = { token: string; shopId?: string | number | null };

/**
 * Client HTTP cho GHN. Dùng `fetch` có sẵn của Node, không thêm dependency —
 * cùng cách các script đồng bộ Sapo trong `scripts/` đang gọi API ngoài.
 */
export class GhnClient {
  private readonly logger = new Logger(GhnClient.name);

  private get baseUrl() {
    return resolveGhnBaseUrl().replace(/\/+$/, '');
  }

  private post<T>(path: string, body: unknown, creds: Credentials): Promise<T> {
    return this.request<T>(path, JSON.stringify(body ?? {}), creds, {
      'Content-Type': 'application/json',
    });
  }

  /** `ticket/reply` là endpoint duy nhất GHN yêu cầu multipart. */
  private postForm<T>(
    path: string,
    fields: Record<string, string>,
    creds: Credentials,
  ): Promise<T> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    // Không set Content-Type — fetch tự thêm kèm boundary
    return this.request<T>(path, form, creds, {});
  }

  private async request<T>(
    path: string,
    body: BodyInit,
    creds: Credentials,
    extraHeaders: Record<string, string>,
  ): Promise<T> {
    const headers: Record<string, string> = {
      ...extraHeaders,
      Token: creds.token,
    };
    if (creds.shopId) headers.ShopId = String(creds.shopId);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/${path}`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      // Timeout / DNS / mất mạng — GHN chưa nhận được gì nên an toàn để báo lỗi ra UI
      this.logger.error(`GHN ${path} không gọi được: ${String(e)}`);
      throw new BusinessException(
        'CARRIER_UNAVAILABLE',
        'Không kết nối được tới GHN, vui lòng thử lại',
        502,
      );
    }

    const raw = (await res.json().catch(() => null)) as GhnEnvelope<T> | null;
    if (!res.ok || !raw || (raw.code !== undefined && raw.code !== 200)) {
      const codeMsg =
        raw?.code_message ?? raw?.message ?? `GHN trả về HTTP ${res.status}`;
      const detail =
        raw?.message && raw.message !== codeMsg ? raw.message : null;
      if (path === 'v2/shipping-order/create' && typeof body === 'string') {
        try {
          const keys = Object.keys(JSON.parse(body) as object).join(', ');
          this.logger.warn(`GHN create payload keys: ${keys}`);
        } catch {
          /* ignore */
        }
      }
      this.logger.warn(
        `GHN ${path} lỗi: ${codeMsg}${detail ? ` | ${detail}` : ''}`,
      );
      const warehouseHint = (detail ?? codeMsg).includes('thông tin kho')
        ? ' Shop GHN cần có đủ Tỉnh/Quận/Phường trên api.ghn.vn → Quản lý cửa hàng.'
        : '';
      const envHint = isGhnSandbox()
        ? 'Môi trường: sandbox (GHN_ENV=sandbox)'
        : 'Môi trường: production (GHN_ENV=production)';
      throw new BusinessException(
        'CARRIER_ERROR',
        `GHN: ${codeMsg}${detail ? ` — ${detail}` : ''}.${warehouseHint} ${envHint}`,
        422,
      );
    }
    return raw.data as T;
  }

  /** Master-data chỉ cần Token — ShopId (nếu gửi kèm) có thể làm GHN trả `data: null`. */
  private tokenOnly(creds: Credentials): Credentials {
    return { token: creds.token };
  }

  /** Master data đôi khi trả `data: null` hoặc một object đơn — chuẩn hoá về mảng. */
  private async postList<T>(
    path: string,
    body: unknown,
    creds: Credentials,
  ): Promise<T[]> {
    const data = await this.post<T[] | T | null>(path, body, creds);
    if (data == null) return [];
    return Array.isArray(data) ? data : [data];
  }

  // --- Master data địa chỉ (dùng để map tên tỉnh/huyện/xã sang ID của GHN) ---

  getProvinces(creds: Credentials) {
    return this.postList<GhnProvince>(
      'master-data/province',
      {},
      this.tokenOnly(creds),
    );
  }

  getDistricts(provinceId: number, creds: Credentials) {
    return this.postList<GhnDistrict>(
      'master-data/district',
      { province_id: provinceId },
      this.tokenOnly(creds),
    );
  }

  getWards(districtId: number, creds: Credentials) {
    return this.postList<GhnWard>(
      'master-data/ward',
      { district_id: districtId },
      this.tokenOnly(creds),
    );
  }

  // --- Cửa hàng ---

  /** `v2/shop/all` — xác thực token và lấy địa chỉ lấy hàng đã đăng ký với GHN. */
  async getShops(creds: Credentials) {
    const data = await this.post<{ shops?: GhnShop[] }>(
      'v2/shop/all',
      { offset: 0, limit: 200 },
      { token: creds.token },
    );
    return data?.shops ?? [];
  }

  // --- Vận đơn ---

  /**
   * `v2/shipping-order/available-services` — dịch vụ khả dụng cho tuyến. Phải gọi để lấy
   * `service_id` thật thay vì đoán `service_type_id`, vì GHN mở dịch vụ khác nhau theo tuyến.
   */
  getAvailableServices(
    input: {
      shopId: number;
      fromDistrict?: number | null;
      toDistrict: number;
    },
    creds: Credentials,
  ) {
    return this.post<GhnService[]>(
      'v2/shipping-order/available-services',
      {
        shop_id: input.shopId,
        to_district: input.toDistrict,
        ...(input.fromDistrict && input.fromDistrict > 0
          ? { from_district: input.fromDistrict }
          : {}),
      },
      creds,
    );
  }

  /**
   * `v2/shipping-order/fee` — phí thật cho 1 `service_id` cụ thể theo tuyến. CHƯA gọi thử API
   * thật (chưa có phiên dev rảnh để test) — payload dựng theo tài liệu GHN chuẩn (from/to
   * district + to_ward_code + kích thước + service_id). Cần xác nhận lại bằng gọi thật trước khi
   * tin tuyệt đối shape response, đúng bài học đã gặp với `getPriceAllNlp` của VTP.
   */
  calculateFee(
    input: {
      serviceId: number;
      fromDistrictId?: number | null;
      toDistrictId: number;
      toWardCode: string;
      weight: number;
      length: number;
      width: number;
      height: number;
      insuranceValue?: number;
    },
    creds: Credentials,
  ) {
    return this.post<GhnFeeResult>(
      'v2/shipping-order/fee',
      {
        service_id: input.serviceId,
        insurance_value: Math.max(0, Math.round(input.insuranceValue ?? 0)),
        coupon: null,
        ...(input.fromDistrictId && input.fromDistrictId > 0
          ? { from_district_id: input.fromDistrictId }
          : {}),
        to_district_id: input.toDistrictId,
        to_ward_code: input.toWardCode,
        height: Math.max(1, Math.round(input.height)),
        length: Math.max(1, Math.round(input.length)),
        weight: Math.max(1, Math.round(input.weight)),
        width: Math.max(1, Math.round(input.width)),
      },
      creds,
    );
  }

  createOrder(payload: GhnCreateOrderPayload, creds: Credentials) {
    return this.post<GhnCreateOrderResult>(
      'v2/shipping-order/create',
      payload,
      creds,
    );
  }

  cancelOrders(orderCodes: string[], creds: Credentials) {
    return this.post<GhnCancelResult[]>(
      'v2/switch-status/cancel',
      { order_codes: orderCodes },
      creds,
    );
  }

  getOrderDetail(orderCode: string, creds: Credentials) {
    return this.post<Record<string, unknown>>(
      'v2/shipping-order/detail',
      { order_code: orderCode },
      creds,
    );
  }

  // --- Ticket (phiếu hỗ trợ với GHN) ---

  createTicket(
    payload: {
      order_code: string;
      category: string;
      description: string;
      c_email?: string;
    },
    creds: Credentials,
  ) {
    return this.post<GhnTicket>('ticket/create', payload, {
      token: creds.token,
    });
  }

  replyTicket(
    payload: { ticket_id: number | string; description: string },
    creds: Credentials,
  ) {
    return this.postForm<GhnTicketConversation>(
      'ticket/reply',
      {
        ticket_id: String(payload.ticket_id),
        description: payload.description,
      },
      { token: creds.token },
    );
  }

  getTickets(creds: Credentials) {
    return this.post<GhnTicket[]>('ticket/index', {}, creds);
  }
}
