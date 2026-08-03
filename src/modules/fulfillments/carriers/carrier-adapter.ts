import { ShipmentStatus } from '@prisma/client';

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

/**
 * Adapter cho từng hãng vận chuyển tích hợp.
 * ManualAdapter: phí từ services_config, webhook mô phỏng.
 * GhnAdapter: status map GHN thật; tạo/hủy đơn qua GhnClient.
 */
export interface CarrierAdapter {
  /** Báo giá các dịch vụ theo khối lượng (gram). */
  quote(services: CarrierServiceConfig[], weightGrams: number): CarrierQuote[];

  /** Map trạng thái từ webhook của hãng → ShipmentStatus nội bộ. */
  mapWebhookStatus(externalStatus: string): ShipmentStatus | null;
}

export const GHN_PROVIDER_CODE = 'ghn';
