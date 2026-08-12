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

/** Dịch vụ thật lấy trực tiếp từ API hãng theo tuyến cụ thể (khác `CarrierQuote` ước tính từ `services_config`). */
export type CarrierServiceOption = {
  code: string;
  name: string;
  eta: string | null;
  fee: number;
};

/** Tuyến (from/to) dùng để hỏi danh sách dịch vụ thật — tái dùng đúng tên field như `CarrierShipmentInput`. */
export type CarrierRouteInput = {
  toAddress: string | null;
  toWard: string | null;
  toDistrict: string | null;
  toProvince: string | null;
  originName: string | null;
  originPhone: string | null;
  originAddress: string | null;
  originWard: string | null;
  originDistrict: string | null;
  originProvince: string | null;
  weightGrams: number;
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

  /**
   * Danh sách dịch vụ THẬT khả dụng cho 1 tuyến cụ thể, lấy trực tiếp từ API hãng (khác `quote`
   * chỉ ước tính từ `services_config`). Chỉ hãng tích hợp API mới có; không có thì gọi nơi dùng
   * tự fallback về `quote`.
   */
  listServices?(
    route: CarrierRouteInput,
    config: CarrierConnectionConfig,
  ): Promise<CarrierServiceOption[]>;

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
