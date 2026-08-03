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
} from './carrier-adapter';
import { GhnLocationResolver } from './ghn-location-resolver';
import { GHN_TRACKING_URL, GhnClient } from './ghn.client';

/** Giá trị `carrier` ghi vào `fulfillments` — cùng vốn từ Sapo (VIETTEL_POST, JT_EXPRESS, GHN...). */
export const GHN_CARRIER = 'GHN';
export const GHN_CARRIER_NAME = 'GHN Express';

/**
 * Toàn bộ trạng thái GHN (docs "List Of Shipping Status") → 8 giá trị `ShipmentStatus` của
 * Sapo. GHN chi tiết hơn nhiều ở khâu trung chuyển nên nhiều trạng thái gộp về `delivering`.
 */
const WEBHOOK_STATUS_MAP: Record<string, ShipmentStatus> = {
  // Chờ lấy hàng
  ready_to_pick: ShipmentStatus.pending,
  picking: ShipmentStatus.pending,
  money_collect_picking: ShipmentStatus.pending,
  // ĐTVC đã lấy hàng — đây là điểm trừ tồn kho (theo Sapo)
  picked: ShipmentStatus.picked_up,
  // Đang trung chuyển / đang giao
  storing: ShipmentStatus.delivering,
  transporting: ShipmentStatus.delivering,
  sorting: ShipmentStatus.delivering,
  delivering: ShipmentStatus.delivering,
  money_collect_delivering: ShipmentStatus.delivering,
  // Giao thành công
  delivered: ShipmentStatus.delivered,
  // Giao lỗi / chờ giao lại
  delivery_fail: ShipmentStatus.retry_delivery,
  waiting_to_return: ShipmentStatus.retry_delivery,
  // Đang chuyển hoàn (hàng chưa về kho — không đụng tồn)
  return: ShipmentStatus.returning,
  return_transporting: ShipmentStatus.returning,
  return_sorting: ShipmentStatus.returning,
  returning: ShipmentStatus.returning,
  return_fail: ShipmentStatus.returning,
  // Hàng đã về kho — nhập lại tồn
  returned: ShipmentStatus.returned,
  // Kết thúc bất thường
  cancel: ShipmentStatus.cancelled,
  // damage / lost / exception: GHN chưa chốt hướng xử lý, để nguyên trạng thái hiện tại
  // và chờ nghiệp vụ xử lý tay — map bừa sẽ làm sai tồn kho.
};

/** Các bước trung gian hợp lệ giữa hai trạng thái nội bộ — GHN hay nhảy cóc. */
const TRANSITIONS: Partial<Record<ShipmentStatus, ShipmentStatus[]>> = {
  [ShipmentStatus.pending]: [ShipmentStatus.picked_up],
  [ShipmentStatus.picked_up]: [ShipmentStatus.delivering],
  [ShipmentStatus.delivering]: [
    ShipmentStatus.delivered,
    ShipmentStatus.retry_delivery,
  ],
  [ShipmentStatus.retry_delivery]: [
    ShipmentStatus.delivering,
    ShipmentStatus.returning,
  ],
  [ShipmentStatus.returning]: [ShipmentStatus.returned],
};

/** `required_note` của GHN ứng với các lựa chọn "Yêu cầu giao hàng" ở UI. */
const REQUIRED_NOTE_MAP: Record<string, string> = {
  'Cho xem hàng, không cho thử': 'CHOXEMHANGKHONGTHU',
  'Cho xem hàng, cho thử hàng': 'CHOTHUHANG',
  'Không cho xem hàng': 'KHONGCHOXEMHANG',
};
const DEFAULT_REQUIRED_NOTE = 'CHOXEMHANGKHONGTHU';

/** Kích thước tối thiểu GHN nhận (đơn hàng nhỏ vẫn phải khai kiện). */
const MIN_DIMENSION_CM = 1;

export class GhnAdapter implements CarrierAdapter {
  private readonly logger = new Logger(GhnAdapter.name);

  constructor(
    private readonly client: GhnClient,
    private readonly locations: GhnLocationResolver,
  ) {}

  /**
   * Báo giá vẫn dùng biểu phí nội bộ (`services_config`) để danh sách dịch vụ hiện ngay
   * lúc mở dialog mà không cần địa chỉ. Phí THẬT chốt khi tạo đơn — `createShipment` trả về
   * `total_fee` của GHN và service ghi đè giá trị ước tính này.
   */
  quote(
    services: CarrierServiceConfig[],
    weightGrams: number,
  ): Promise<CarrierQuote[]> {
    return Promise.resolve(
      services.map((s) => ({
        code: s.code,
        name: s.name,
        eta: s.eta,
        fee:
          s.base_fee +
          Math.max(0, Math.ceil(weightGrams / 500) - 1) * s.extra_fee_per_500g,
      })),
    );
  }

  mapWebhookStatus(externalStatus: string): ShipmentStatus | null {
    const key = externalStatus.trim().toLowerCase();
    return WEBHOOK_STATUS_MAP[key] ?? null;
  }

  isCancelStatus(externalStatus: string): boolean {
    return externalStatus.trim().toLowerCase() === 'cancel';
  }

  /**
   * Tìm chuỗi trạng thái trung gian để đi từ `from` tới `to`.
   * Trả [] nếu đã ở đích; null nếu không tới được.
   */
  pathTo(from: ShipmentStatus, to: ShipmentStatus): ShipmentStatus[] | null {
    if (from === to) return [];
    const queue: { status: ShipmentStatus; path: ShipmentStatus[] }[] = [
      { status: from, path: [] },
    ];
    const seen = new Set<ShipmentStatus>([from]);
    while (queue.length) {
      const cur = queue.shift()!;
      for (const next of TRANSITIONS[cur.status] ?? []) {
        if (seen.has(next)) continue;
        const path = [...cur.path, next];
        if (next === to) return path;
        seen.add(next);
        queue.push({ status: next, path });
      }
    }
    return null;
  }

  async createShipment(
    input: CarrierShipmentInput,
    config: CarrierConnectionConfig,
  ): Promise<CarrierShipmentResult> {
    const creds = this.credentials(config);
    const shopId = Number(config.shop_id);

    const to = await this.locations.resolve(
      {
        province: input.toProvince,
        district: input.toDistrict,
        ward: input.toWard,
      },
      creds,
    );

    const service = await this.pickService(input.serviceCode, {
      shopId,
      fromDistrict: config.from_district_id ?? null,
      toDistrict: to.districtId,
      creds,
    });

    const created = await this.client.createOrder(
      {
        client_order_code: input.clientOrderCode,
        to_name: input.toName,
        to_phone: input.toPhone,
        to_address: input.toAddress,
        to_ward_code: to.wardCode,
        to_district_id: to.districtId,
        // Địa chỉ lấy hàng: ưu tiên kho của đơn, thiếu thì GHN dùng shop mặc định
        ...(input.originName ? { from_name: input.originName } : {}),
        ...(input.originPhone ? { from_phone: input.originPhone } : {}),
        ...(input.originAddress ? { from_address: input.originAddress } : {}),
        ...(input.originWard ? { from_ward_name: input.originWard } : {}),
        ...(input.originDistrict
          ? { from_district_name: input.originDistrict }
          : {}),
        ...(input.originProvince
          ? { from_province_name: input.originProvince }
          : {}),
        cod_amount: Math.max(0, Math.round(input.codAmount)),
        insurance_value: Math.max(0, Math.round(input.insuranceValue)),
        weight: Math.max(1, Math.round(input.weightGrams)),
        length: Math.max(MIN_DIMENSION_CM, input.lengthCm ?? MIN_DIMENSION_CM),
        width: Math.max(MIN_DIMENSION_CM, input.widthCm ?? MIN_DIMENSION_CM),
        height: Math.max(MIN_DIMENSION_CM, input.heightCm ?? MIN_DIMENSION_CM),
        ...(service.serviceId ? { service_id: service.serviceId } : {}),
        service_type_id: service.serviceTypeId,
        // 1 = shop trả phí, 2 = người nhận trả phí
        payment_type_id: input.feePayer === ShippingFeePayer.khach_tra ? 2 : 1,
        required_note:
          REQUIRED_NOTE_MAP[input.deliveryRequirement ?? ''] ??
          DEFAULT_REQUIRED_NOTE,
        ...(input.note ? { note: input.note } : {}),
        items: input.items.map((i) => ({
          name: i.name,
          ...(i.code ? { code: i.code } : {}),
          quantity: i.quantity,
          price: Math.max(0, Math.round(i.price)),
          // GHN đòi weight từng dòng; chia đều khối lượng kiện cho số lượng hàng
          weight: Math.max(
            1,
            Math.round(
              input.weightGrams / Math.max(1, totalQuantity(input.items)),
            ),
          ),
        })),
      },
      creds,
    );

    if (!created?.order_code) {
      throw new BusinessException(
        'CARRIER_ERROR',
        'GHN không trả về mã vận đơn',
        502,
      );
    }

    return {
      trackingNumber: created.order_code,
      trackingUrl: `${GHN_TRACKING_URL}${created.order_code}`,
      carrier: GHN_CARRIER,
      carrierName: GHN_CARRIER_NAME,
      shippingFee: Number(created.total_fee ?? 0),
      expectedDeliveryDate: parseDate(created.expected_delivery_time),
    };
  }

  async cancelShipment(
    trackingNumber: string,
    config: CarrierConnectionConfig,
  ) {
    const results = await this.client.cancelOrders(
      [trackingNumber],
      this.credentials(config),
    );
    const result =
      results?.find((r) => r.order_code === trackingNumber) ?? results?.[0];
    if (!result?.result) {
      throw new BusinessException(
        'CARRIER_ERROR',
        `GHN không hủy được vận đơn ${trackingNumber}: ${result?.message ?? 'không rõ lý do'}`,
        422,
      );
    }
  }

  /**
   * Chọn dịch vụ GHN cho tuyến. Ưu tiên khớp tên dịch vụ ("Chuẩn"/"Nhanh") với
   * `service_code` nội bộ; không khớp thì lấy dịch vụ đầu tiên GHN mở cho tuyến đó.
   */
  private async pickService(
    serviceCode: string | null,
    ctx: {
      shopId: number;
      fromDistrict: number | null;
      toDistrict: number;
      creds: { token: string; shopId?: string | number | null };
    },
  ): Promise<{ serviceId: number | null; serviceTypeId: number }> {
    if (!ctx.fromDistrict) {
      // Chưa kết nối đủ (thiếu địa chỉ lấy hàng) — để GHN tự chọn theo loại dịch vụ
      return { serviceId: null, serviceTypeId: 2 };
    }

    let services: {
      service_id: number;
      short_name: string;
      service_type_id: number;
    }[];
    try {
      services = await this.client.getAvailableServices(
        {
          shopId: ctx.shopId,
          fromDistrict: ctx.fromDistrict,
          toDistrict: ctx.toDistrict,
        },
        ctx.creds,
      );
    } catch (e) {
      this.logger.warn(`Không lấy được dịch vụ khả dụng của GHN: ${String(e)}`);
      return { serviceId: null, serviceTypeId: 2 };
    }

    if (!services?.length) {
      throw new BusinessException(
        'CARRIER_ERROR',
        'GHN không có dịch vụ khả dụng cho tuyến giao hàng này',
        422,
      );
    }

    const wanted = serviceCode === 'fast' ? 'nhanh' : 'chuan';
    const matched =
      services.find((s) => normalizeServiceName(s.short_name) === wanted) ??
      services[0];
    return {
      serviceId: matched.service_id,
      serviceTypeId: matched.service_type_id,
    };
  }

  private credentials(config: CarrierConnectionConfig) {
    if (!config?.token || !config?.shop_id) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'GHN chưa được kết nối (thiếu Token hoặc ShopID)',
        422,
      );
    }
    return { token: config.token, shopId: config.shop_id };
  }
}

function totalQuantity(items: { quantity: number }[]) {
  return items.reduce((sum, i) => sum + i.quantity, 0);
}

function normalizeServiceName(s: string) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .toLowerCase()
    .trim();
}

function parseDate(value?: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
