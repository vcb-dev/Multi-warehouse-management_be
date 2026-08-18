import { Logger } from '@nestjs/common';
import { BusinessException } from '../../../common/exceptions/business.exception';

const SANDBOX_BASE_URL = 'https://partnerdev.viettelpost.vn';
const PRODUCTION_BASE_URL = 'https://partner.viettelpost.vn';

/**
 * VTP_ENV=sandbox|test|dev → partnerdev.viettelpost.vn
 * VTP_ENV=production (mặc định) → partner.viettelpost.vn
 * VTP_BASE_URL / VTP_API_BASE_URL nếu set sẽ ghi đè VTP_ENV — cùng quy ước với GHN_ENV/GHN_BASE_URL.
 */
export function resolveVtpBaseUrl(): string {
  const explicit =
    process.env.VTP_API_BASE_URL?.trim() || process.env.VTP_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const env = (process.env.VTP_ENV ?? 'production').trim().toLowerCase();
  if (env === 'sandbox' || env === 'test' || env === 'dev') {
    return SANDBOX_BASE_URL;
  }
  return PRODUCTION_BASE_URL;
}

export function isVtpSandbox(): boolean {
  return resolveVtpBaseUrl().includes('partnerdev');
}

/**
 * Nhận diện chuỗi đã là session token (JWT 3 đoạn, vd tài khoản đối tác được cấp hạn dùng dài
 * tới nhiều năm — xác nhận thực tế 2026-08-10), khác "tham số bí mật" ngắn dùng cho `LoginVTP`.
 * JWT không đổi lại được qua `LoginVTP` (VTP trả lỗi), nên phải dùng thẳng làm token phiên.
 */
export function isVtpSessionToken(value: string): boolean {
  return value.split('.').length === 3 && value.startsWith('eyJ');
}

/** Token phiên đổi từ "tham số bí mật" — có hạn dùng (`expired`, epoch ms), khác token tĩnh của GHN. */
export type VtpLoginResult = {
  token: string;
  expired: number;
  userId?: number;
};

export type VtpExtraService = {
  SERVICE_CODE: string;
  SERVICE_NAME: string;
  DESCRIPTION?: string | null;
};

/** Một dịch vụ khả dụng cho tuyến, kèm giá — trả về từ `getPriceAllNlp` (gộp cả 2 việc: liệt kê + báo giá). */
export type VtpServiceQuote = {
  MA_DV_CHINH: string;
  TEN_DICHVU: string;
  GIA_CUOC: number;
  THOI_GIAN: string;
  EXCHANGE_WEIGHT?: number;
  EXTRA_SERVICE?: VtpExtraService[];
};

export type VtpPriceAllNlpPayload = {
  SENDER_ADDRESS: string;
  RECEIVER_ADDRESS: string;
  /** Bắt buộc dù endpoint là "địa chỉ dạng text" — VTP vẫn cần ID tỉnh nhận để tính đúng bảng giá theo vùng. */
  RECEIVER_PROVINCE: number;
  PRODUCT_TYPE: 'HH' | 'TH';
  PRODUCT_WEIGHT: number;
  PRODUCT_PRICE: number;
  MONEY_COLLECTION: number;
  PRODUCT_LENGTH: number;
  PRODUCT_WIDTH: number;
  PRODUCT_HEIGHT: number;
  /** 0 = quốc tế, 1 = trong nước */
  TYPE: 0 | 1;
};

export type VtpCreateOrderNlpPayload = {
  /** Mã đơn CỦA APP gửi lên để đối soát — khác nghĩa với `ORDER_NUMBER` ở response (VTP tự sinh). */
  ORDER_NUMBER: string;
  SENDER_FULLNAME: string;
  SENDER_ADDRESS: string;
  SENDER_PHONE: string;
  RECEIVER_FULLNAME: string;
  RECEIVER_ADDRESS: string;
  RECEIVER_PHONE: string;
  PRODUCT_NAME: string;
  PRODUCT_DESCRIPTION?: string;
  PRODUCT_QUANTITY: number;
  PRODUCT_PRICE: number;
  PRODUCT_WEIGHT: number;
  PRODUCT_LENGTH: number;
  PRODUCT_WIDTH: number;
  PRODUCT_HEIGHT: number;
  /** 1=không thu hộ, 2=thu hộ hàng+cước, 3=thu hộ hàng, 4=thu hộ cước */
  ORDER_PAYMENT: 1 | 2 | 3 | 4;
  ORDER_SERVICE: string;
  PRODUCT_TYPE: 'HH' | 'TH';
  ORDER_SERVICE_ADD?: string | null;
  ORDER_NOTE?: string;
  MONEY_COLLECTION: number;
  EXTRA_MONEY?: number;
  CHECK_UNIQUE?: boolean;
  PRODUCT_DETAIL?: {
    PRODUCT_NAME: string;
    PRODUCT_QUANTITY: number;
    PRODUCT_PRICE: number;
    PRODUCT_WEIGHT: number;
  }[];
};

export type VtpCreateOrderResult = {
  /** Mã vận đơn do ViettelPost tự sinh — dùng làm trackingNumber. */
  ORDER_NUMBER: string;
  MONEY_TOTAL: number;
  MONEY_TOTAL_FEE?: number;
  KPI_HT?: number;
};

export type VtpUpdateOrderPayload = {
  /** 1 Duyệt đơn, 2 Duyệt hoàn, 3 Phát tiếp, 4 Hủy đơn, 11 Xoá đơn đã hủy */
  TYPE: 1 | 2 | 3 | 4 | 11;
  ORDER_NUMBER: string;
  NOTE?: string;
};

export type VtpProvince = {
  PROVINCE_ID: number;
  PROVINCE_CODE: string;
  PROVINCE_NAME: string;
};

type VtpEnvelope<T> = {
  status?: number;
  error?: boolean;
  message?: string;
  data?: T;
};

export type VtpCredentials = { token: string };

/**
 * Client HTTP cho ViettelPost. Dùng `fetch` trần, cùng phong cách `GhnClient` — không thêm
 * dependency.
 */
export class VtpClient {
  private readonly logger = new Logger(VtpClient.name);

  private get baseUrl() {
    return resolveVtpBaseUrl();
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    creds: VtpCredentials | null,
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (creds) headers.Token = creds.token;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      // Timeout / DNS / mất mạng — VTP chưa nhận được gì nên an toàn để báo lỗi ra UI
      this.logger.error(`VTP ${path} không gọi được: ${String(e)}`);
      throw new BusinessException(
        'CARRIER_UNAVAILABLE',
        'Không kết nối được tới ViettelPost, vui lòng thử lại',
        502,
      );
    }

    const raw = (await res.json().catch(() => null)) as
      | (VtpEnvelope<T> & Record<string, unknown>)
      | null;
    if (!res.ok || !raw || raw.error) {
      const message = raw?.message ?? `ViettelPost trả về HTTP ${res.status}`;
      this.logger.warn(`VTP ${path} lỗi: ${message}`);
      const envHint = isVtpSandbox()
        ? 'Môi trường: sandbox (VTP_ENV=sandbox)'
        : 'Môi trường: production (VTP_ENV=production)';
      throw new BusinessException(
        'CARRIER_ERROR',
        `ViettelPost: ${message}. ${envHint}`,
        422,
      );
    }
    // Đa số endpoint bọc kết quả trong `data` — nhưng getPriceAllNlp (xác nhận bằng gọi thật
    // trên production 2026-08-10) trả thẳng object kết quả ở top-level, không có field `data`.
    // Dùng `'data' in raw` (không phải `raw.data`) để phân biệt "có data nhưng null" (vd
    // UpdateOrder) với "không bọc data" (getPriceAllNlp).
    return ('data' in raw ? raw.data : raw) as T;
  }

  /** `POST /v2/user/LoginVTP` — đổi "tham số bí mật" (lấy từ web VTP) sang token phiên có hạn dùng. */
  loginVtp(secretToken: string) {
    return this.request<VtpLoginResult>(
      'POST',
      'v2/user/LoginVTP',
      { token: secretToken },
      null,
    );
  }

  /**
   * `POST /v2/order/getPriceAllNlp` — vừa liệt kê dịch vụ khả dụng vừa báo giá, theo địa chỉ
   * text. Xác nhận bằng gọi thật trên production (2026-08-10): response KHÔNG bọc trong
   * `{status,error,message,data}` như các endpoint khác — trả thẳng
   * `{ SENDER_ADDRESS, RECEIVER_ADDRESS, RESULT: [...] }` ở top-level (đã xử lý ở
   * `request()`). Bóc `RESULT` ngay ở đây để phía gọi vẫn nhận về mảng như cũ.
   */
  async getPriceAllNlp(
    payload: VtpPriceAllNlpPayload,
    creds: VtpCredentials,
  ): Promise<VtpServiceQuote[]> {
    const result = await this.request<{ RESULT?: VtpServiceQuote[] }>(
      'POST',
      'v2/order/getPriceAllNlp',
      payload,
      creds,
    );
    return result?.RESULT ?? [];
  }

  /** `POST /v2/order/createOrderNlp` — tạo vận đơn bằng địa chỉ text, không cần ID địa danh. */
  createOrderNlp(payload: VtpCreateOrderNlpPayload, creds: VtpCredentials) {
    return this.request<VtpCreateOrderResult>(
      'POST',
      'v2/order/createOrderNlp',
      payload,
      creds,
    );
  }

  /** `POST /v2/order/UpdateOrder` — hủy đơn (TYPE=4) và các thao tác cập nhật trạng thái khác. */
  updateOrder(payload: VtpUpdateOrderPayload, creds: VtpCredentials) {
    return this.request<unknown>(
      'POST',
      'v2/order/UpdateOrder',
      payload,
      creds,
    );
  }

  /** `GET /v3/categories/listProvinceNew` — danh mục Tỉnh/TP mới (sau sáp nhập), chỉ dùng để đổi tên → ID cho `RECEIVER_PROVINCE`. */
  listProvincesNew(creds: VtpCredentials) {
    return this.request<VtpProvince[]>(
      'GET',
      'v3/categories/listProvinceNew',
      null,
      creds,
    );
  }
}
