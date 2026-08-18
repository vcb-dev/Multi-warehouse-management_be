import { Logger } from '@nestjs/common';
import { ShipmentStatus, ShippingFeePayer } from '@prisma/client';
import { BusinessException } from '../../../common/exceptions/business.exception';
import {
  CarrierAdapter,
  CarrierConnectionConfig,
  CarrierQuote,
  CarrierServiceConfig,
  CarrierShipmentInput,
  CarrierShipmentResult,
  estimateQuote,
} from './carrier-adapter';
import {
  VtpClient,
  VtpCredentials,
  VtpProvince,
  VtpServiceQuote,
  isVtpSessionToken,
} from './vtp.client';

/** Giá trị `carrier` ghi vào `fulfillments` — cùng vốn từ Sapo (VIETTEL_POST, JT_EXPRESS, GHN...). */
export const VTP_CARRIER = 'VIETTEL_POST';
export const VTP_CARRIER_NAME = 'Viettel Post';

/** Refresh token phiên sớm hơn hạn thật để tránh vừa dùng vừa hết hạn giữa chừng 1 request. */
const SESSION_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const PROVINCE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Mã `ORDER_STATUS` ViettelPost (mục 8 tài liệu, 101–550) → 8 giá trị `ShipmentStatus` nội bộ.
 * Nhóm dựa theo bảng trạng thái trong tài liệu; cần đối chiếu lại với webhook thật khi test ở
 * dev (Phase E) vì tài liệu không mô tả rõ ranh giới giữa vài mã (vd 200, 202, 509, 515) — để
 * trống các mã đó (không map) thay vì đoán bừa, giống cách GHN bỏ trống damage/lost/exception.
 */
const WEBHOOK_STATUS_MAP: Record<string, ShipmentStatus> = {
  '102': ShipmentStatus.pending, // Đơn hàng chờ xử lý
  '103': ShipmentStatus.pending, // Giao cho bưu cục
  '104': ShipmentStatus.pending, // Giao cho bưu tá đi nhận
  '105': ShipmentStatus.picked_up, // Bưu tá đã nhận hàng — điểm trừ tồn kho
  '300': ShipmentStatus.delivering, // Khai thác đi
  '400': ShipmentStatus.delivering, // Khai thác đến
  '500': ShipmentStatus.delivering, // Giao bưu tá đi phát
  '508': ShipmentStatus.delivering, // Phát tiếp (đơn vị yêu cầu)
  '550': ShipmentStatus.delivering, // Phát tiếp (khách hàng yêu cầu)
  '501': ShipmentStatus.delivered, // Phát thành công
  '505': ShipmentStatus.retry_delivery, // Tồn - thông báo chuyển hoàn
  '506': ShipmentStatus.retry_delivery, // Tồn - khách nghỉ/không có nhà
  '507': ShipmentStatus.retry_delivery, // Tồn - khách đến bưu cục nhận
  '502': ShipmentStatus.returning, // Chuyển hoàn bưu cục gốc
  '504': ShipmentStatus.returned, // Hoàn thành công - chuyển trả người gửi
  '107': ShipmentStatus.cancelled, // Đối tác yêu cầu hủy qua API
  '201': ShipmentStatus.cancelled, // Hủy nhập phiếu gửi
  '503': ShipmentStatus.cancelled, // Hủy - theo yêu cầu khách hàng
};

/** Bỏ dấu + hạ chữ thường + bỏ tiền tố hành chính — đủ dùng cho khớp tên 34 Tỉnh/TP, không cần bộ khớp nhiều tầng như GHN (quận/huyện/xã). */
function normalizeProvinceName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/^(thanh pho|tinh)\s+/, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function joinAddress(...parts: (string | null | undefined)[]): string {
  return parts
    .filter((p): p is string => !!p && p.trim().length > 0)
    .join(', ');
}

function totalQuantity(items: { quantity: number }[]) {
  return items.reduce((sum, i) => sum + i.quantity, 0);
}

/**
 * `ORDER_PAYMENT` VTP không tương ứng "ai trả phí ship" như `payment_type_id` của GHN — đây là
 * loại thu hộ (COD): thu hàng, thu cước, cả hai, hay không thu gì.
 */
function pickOrderPayment(
  feePayer: ShippingFeePayer,
  codAmount: number,
): 1 | 2 | 3 | 4 {
  const hasCod = codAmount > 0;
  if (feePayer === ShippingFeePayer.khach_tra) {
    return hasCod ? 2 : 4; // thu hộ hàng+cước, hoặc chỉ thu cước
  }
  return hasCod ? 3 : 1; // thu hộ hàng (shop tự trả cước), hoặc không thu gì
}

export class VtpAdapter implements CarrierAdapter {
  private readonly logger = new Logger(VtpAdapter.name);

  /** Cache token phiên theo "tham số bí mật" — trong bộ nhớ process, không ghi DB (giống cache của GhnLocationResolver). */
  private readonly sessions = new Map<
    string,
    { creds: VtpCredentials; expiresAt: number }
  >();
  private provinceCache: { at: number; list: VtpProvince[] } | null = null;

  constructor(private readonly client: VtpClient) {}

  quote(
    services: CarrierServiceConfig[],
    weightGrams: number,
  ): Promise<CarrierQuote[]> {
    return Promise.resolve(estimateQuote(services, weightGrams));
  }

  mapWebhookStatus(externalStatus: string): ShipmentStatus | null {
    return WEBHOOK_STATUS_MAP[externalStatus.trim()] ?? null;
  }

  async createShipment(
    input: CarrierShipmentInput,
    config: CarrierConnectionConfig,
  ): Promise<CarrierShipmentResult> {
    const creds = await this.ensureSession(config);

    const senderAddress = joinAddress(
      input.originAddress,
      input.originWard,
      input.originDistrict,
      input.originProvince,
    );
    const receiverAddress = joinAddress(
      input.toAddress,
      input.toWard,
      input.toDistrict,
      input.toProvince,
    );
    if (!senderAddress || !receiverAddress || !input.toProvince) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Địa chỉ giao/nhận hàng phải có đủ Tỉnh/Thành, Quận/Huyện, Phường/Xã để tạo vận đơn ViettelPost',
        422,
      );
    }

    const receiverProvinceId = await this.resolveProvinceId(
      input.toProvince,
      creds,
    );
    const weight = Math.max(1, Math.round(input.weightGrams));
    const insuranceValue = Math.max(0, Math.round(input.insuranceValue));
    const codAmount = Math.max(0, Math.round(input.codAmount));

    const quotes = await this.client.getPriceAllNlp(
      {
        SENDER_ADDRESS: senderAddress,
        RECEIVER_ADDRESS: receiverAddress,
        RECEIVER_PROVINCE: receiverProvinceId,
        PRODUCT_TYPE: 'HH',
        PRODUCT_WEIGHT: weight,
        PRODUCT_PRICE: insuranceValue,
        MONEY_COLLECTION: codAmount,
        PRODUCT_LENGTH: input.lengthCm ?? 0,
        PRODUCT_WIDTH: input.widthCm ?? 0,
        PRODUCT_HEIGHT: input.heightCm ?? 0,
        TYPE: 1,
      },
      creds,
    );
    const service = this.pickService(input.serviceCode, quotes);

    const qty = totalQuantity(input.items);
    const created = await this.client.createOrderNlp(
      {
        ORDER_NUMBER: input.clientOrderCode,
        SENDER_FULLNAME: input.originName ?? '',
        SENDER_ADDRESS: senderAddress,
        SENDER_PHONE: input.originPhone ?? '',
        RECEIVER_FULLNAME: input.toName,
        RECEIVER_ADDRESS: receiverAddress,
        RECEIVER_PHONE: input.toPhone,
        PRODUCT_NAME: input.items[0]?.name ?? 'Hàng hóa',
        ...(input.note ? { PRODUCT_DESCRIPTION: input.note } : {}),
        PRODUCT_QUANTITY: qty,
        PRODUCT_PRICE: insuranceValue,
        PRODUCT_WEIGHT: weight,
        PRODUCT_LENGTH: input.lengthCm ?? 0,
        PRODUCT_WIDTH: input.widthCm ?? 0,
        PRODUCT_HEIGHT: input.heightCm ?? 0,
        ORDER_PAYMENT: pickOrderPayment(input.feePayer, codAmount),
        ORDER_SERVICE: service.code,
        PRODUCT_TYPE: 'HH',
        ...(input.note ? { ORDER_NOTE: input.note } : {}),
        MONEY_COLLECTION: codAmount,
        CHECK_UNIQUE: true,
        PRODUCT_DETAIL: input.items.map((i) => ({
          PRODUCT_NAME: i.name,
          PRODUCT_QUANTITY: i.quantity,
          PRODUCT_PRICE: Math.max(0, Math.round(i.price)),
          PRODUCT_WEIGHT: Math.max(1, Math.round(weight / Math.max(1, qty))),
        })),
      },
      creds,
    );

    if (!created?.ORDER_NUMBER) {
      throw new BusinessException(
        'CARRIER_ERROR',
        'ViettelPost không trả về mã vận đơn',
        502,
      );
    }

    return {
      trackingNumber: created.ORDER_NUMBER,
      // VTP không có trang tra cứu công khai đơn giản theo mã như GHN — để trống, bổ sung sau nếu cần (mục "in vận đơn").
      trackingUrl: null,
      carrier: VTP_CARRIER,
      carrierName: VTP_CARRIER_NAME,
      shippingFee: Number(created.MONEY_TOTAL ?? 0),
      // Response tạo đơn không trả ngày giao dự kiến (chỉ có ở webhook) — để trống thay vì đoán.
      expectedDeliveryDate: null,
    };
  }

  async cancelShipment(
    trackingNumber: string,
    config: CarrierConnectionConfig,
  ): Promise<void> {
    const creds = await this.ensureSession(config);
    // VtpClient.request đã ném BusinessException khi VTP trả error:true — tới đây coi như đã hủy.
    await this.client.updateOrder(
      {
        TYPE: 4,
        ORDER_NUMBER: trackingNumber,
        NOTE: 'Hủy từ hệ thống quản lý bán hàng',
      },
      creds,
    );
  }

  /**
   * Chọn `MA_DV_CHINH` cho tuyến. Không có quy ước tên dịch vụ cố định giữa các hợp đồng VTP
   * (khác GHN luôn có "Chuẩn"/"Nhanh") nên dùng heuristic theo giá: `serviceCode==='fast'` lấy
   * dịch vụ đắt nhất (thường là hỏa tốc), mặc định lấy rẻ nhất. Cần đối chiếu lại với danh sách
   * dịch vụ thật của tài khoản dev khi test (Phase E).
   */
  private pickService(
    serviceCode: string | null,
    quotes: VtpServiceQuote[],
  ): { code: string; feeVnd: number } {
    if (!quotes?.length) {
      throw new BusinessException(
        'CARRIER_ERROR',
        'ViettelPost không có dịch vụ khả dụng cho tuyến giao hàng này',
        422,
      );
    }
    const sorted = [...quotes].sort((a, b) => a.GIA_CUOC - b.GIA_CUOC);
    const matched =
      serviceCode === 'fast' ? sorted[sorted.length - 1] : sorted[0];
    return { code: matched.MA_DV_CHINH, feeVnd: matched.GIA_CUOC };
  }

  /** Đổi tên Tỉnh/TP nội bộ sang `PROVINCE_ID` của VTP (danh mục mới V3) — cache 24h, dùng chung cho mọi kết nối. */
  private async resolveProvinceId(
    provinceName: string,
    creds: VtpCredentials,
  ): Promise<number> {
    if (
      !this.provinceCache ||
      Date.now() - this.provinceCache.at > PROVINCE_CACHE_TTL_MS
    ) {
      const list = await this.client.listProvincesNew(creds);
      this.provinceCache = { at: Date.now(), list };
    }
    const wanted = normalizeProvinceName(provinceName);
    const found = this.provinceCache.list.find((p) => {
      const name = normalizeProvinceName(p.PROVINCE_NAME);
      return name === wanted || name.includes(wanted) || wanted.includes(name);
    });
    if (!found) {
      throw new BusinessException(
        'CARRIER_ADDRESS_UNMATCHED',
        `ViettelPost không nhận diện được Tỉnh/Thành "${provinceName}". Vui lòng chọn lại địa chỉ giao hàng.`,
        422,
      );
    }
    return found.PROVINCE_ID;
  }

  /**
   * Refresh token phiên khi gần hết hạn — `config.token` thường là "tham số bí mật" dài hạn,
   * nhưng tài khoản đối tác có thể được cấp thẳng session JWT hạn dùng dài (xác nhận thực tế:
   * tài khoản 8501446 nhận JWT hạn tới 2029) — JWT không đổi lại được qua `LoginVTP` nên dùng
   * thẳng, không refresh.
   */
  private async ensureSession(
    config: CarrierConnectionConfig,
  ): Promise<VtpCredentials> {
    const secret = config?.token?.trim();
    if (!secret) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'ViettelPost chưa được kết nối (thiếu Token)',
        422,
      );
    }
    if (isVtpSessionToken(secret)) {
      return { token: secret };
    }
    const cached = this.sessions.get(secret);
    if (cached && cached.expiresAt - SESSION_REFRESH_BUFFER_MS > Date.now()) {
      return cached.creds;
    }
    const login = await this.client.loginVtp(secret);
    if (!login?.token) {
      throw new BusinessException(
        'CARRIER_ERROR',
        'ViettelPost không xác thực được Token',
        422,
      );
    }
    const creds: VtpCredentials = { token: login.token };
    const expiresAt =
      login.expired && login.expired > Date.now()
        ? login.expired
        : Date.now() + 55 * 60 * 1000;
    this.sessions.set(secret, { creds, expiresAt });
    return creds;
  }
}
