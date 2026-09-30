import { ShipmentStatus, ShippingFeePayer } from '@prisma/client';

export type CarrierServiceConfig = {
  code: string;
  name: string;
  eta: string;
  base_fee: number;
  extra_fee_per_500g: number;
};

export type CarrierQuote = {
  code: string;
  name: string;
  eta: string;
  fee: number;
};

/** Cấu hình kết nối lưu ở `shipping_providers.connection_config`. */
export type CarrierConnectionConfig = {
  token?: string | null;
  shop_id?: string | null;
  /** GHN `client_id` — cần khi đăng ký webhook với hãng. */
  client_id?: string | null;
  // Địa chỉ lấy hàng đã đăng ký ở phía hãng (tự lấy khi kết nối)
  from_name?: string | null;
  from_phone?: string | null;
  from_address?: string | null;
  from_district_id?: number | null;
  from_ward_code?: string | null;
};

/** Đơn hàng cần đẩy sang hãng — đã gom sẵn ở service, adapter không truy DB. */
export type CarrierShipmentInput = {
  /** Mã đơn của app (Sapo `order.name`) — gửi làm `client_order_code` để đối soát. */
  clientOrderCode: string;
  serviceCode: string | null;
  toName: string;
  toPhone: string;
  toAddress: string;
  toWard: string | null;
  toDistrict: string | null;
  toProvince: string | null;
  originName: string | null;
  originPhone: string | null;
  originAddress: string | null;
  originWard: string | null;
  originDistrict: string | null;
  originProvince: string | null;
  codAmount: number;
  insuranceValue: number;
  /** Ai trả phí vận chuyển — GHN map sang `payment_type_id`. */
  feePayer: ShippingFeePayer;
  weightGrams: number;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  deliveryRequirement: string | null;
  note: string | null;
  items: {
    name: string;
    code: string | null;
    quantity: number;
    price: number;
  }[];
};

/**
 * Kết quả tạo vận đơn — tên trường theo đúng cột Sapo trên `fulfillments`
 * (`tracking_number`, `tracking_url`, `carrier`, `expected_delivery_date`...) để service
 * ghi thẳng vào DB, không phải dịch thêm một lớp nữa.
 */
export type CarrierShipmentResult = {
  trackingNumber: string;
  trackingUrl: string | null;
  carrier: string;
  carrierName: string;
  shippingFee: number;
  expectedDeliveryDate: Date | null;
};

/**
 * Ước tính phí từ biểu phí nội bộ `services_config` — dùng chung cho mọi adapter khi báo giá
 * (trước khi tạo đơn thật). Phí THẬT do hãng trả về lúc `createShipment` sẽ ghi đè con số này.
 */
export function estimateQuote(
  services: CarrierServiceConfig[],
  weightGrams: number,
): CarrierQuote[] {
  return services.map((s) => ({
    code: s.code,
    name: s.name,
    eta: s.eta,
    fee:
      s.base_fee +
      Math.max(0, Math.ceil(weightGrams / 500) - 1) * s.extra_fee_per_500g,
  }));
}

/**
 * Vòng đời vận đơn theo Sapo (khớp bảng `allowed` trong `applyShipmentStatus`), dùng để
 * webhook đi qua các bước trung gian khi hãng nhảy cóc — VD VTP báo 502 (chuyển hoàn) ngay
 * sau 500 (đang giao) mà không có 505, hoặc lỡ mất 105 (đã lấy hàng) rồi báo thẳng 300.
 * Không có `cancelled`: hủy đi thẳng từ mọi trạng thái đang mở, xem `shipmentPathTo`.
 */
export const SHIPMENT_TRANSITIONS: Partial<
  Record<ShipmentStatus, ShipmentStatus[]>
> = {
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

/**
 * Chuỗi trạng thái cần áp lần lượt để đi từ `from` tới `to` (không gồm `from`).
 * Trả [] nếu đã ở đích; null nếu không tới được — tức webhook đến sai thứ tự (VD báo
 * "đang giao" sau khi đã "đang hoàn"), bỏ qua là đúng.
 */
export function shipmentPathTo(
  from: ShipmentStatus,
  to: ShipmentStatus,
): ShipmentStatus[] | null {
  if (from === to) return [];
  if (to === ShipmentStatus.cancelled) return [ShipmentStatus.cancelled];
  const queue: { status: ShipmentStatus; path: ShipmentStatus[] }[] = [
    { status: from, path: [] },
  ];
  const seen = new Set<ShipmentStatus>([from]);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of SHIPMENT_TRANSITIONS[cur.status] ?? []) {
      if (seen.has(next)) continue;
      const path = [...cur.path, next];
      if (next === to) return path;
      seen.add(next);
      queue.push({ status: next, path });
    }
  }
  return null;
}

/**
 * Adapter cho từng hãng vận chuyển. `ManualAdapter` là mặc định (báo giá từ
 * services_config, trạng thái cập nhật thủ công); hãng có API thật (GHN) cài thêm
 * `createShipment`/`cancelShipment`.
 */
export interface CarrierAdapter {
  /** Báo giá các dịch vụ theo khối lượng (gram). */
  quote(
    services: CarrierServiceConfig[],
    weightGrams: number,
  ): Promise<CarrierQuote[]>;

  /** Map trạng thái từ webhook của hãng → ShipmentStatus nội bộ. */
  mapWebhookStatus(externalStatus: string): ShipmentStatus | null;

  /** Tạo vận đơn thật ở hệ thống hãng. Chỉ hãng tích hợp API mới có. */
  createShipment?(
    input: CarrierShipmentInput,
    config: CarrierConnectionConfig,
  ): Promise<CarrierShipmentResult>;

  /** Hủy vận đơn ở hệ thống hãng. Chỉ hãng tích hợp API mới có. */
  cancelShipment?(
    trackingNumber: string,
    config: CarrierConnectionConfig,
  ): Promise<void>;
}
