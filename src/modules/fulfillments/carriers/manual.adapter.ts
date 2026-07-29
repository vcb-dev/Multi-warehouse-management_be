import { ShipmentStatus } from '@prisma/client';
import {
  CarrierAdapter,
  CarrierQuote,
  CarrierServiceConfig,
} from './carrier-adapter';

// Trạng thái webhook của ĐTVC → trạng thái vận đơn (đã trùng tên với Sapo)
const WEBHOOK_STATUS_MAP: Record<string, ShipmentStatus> = {
  picked_up: ShipmentStatus.picked_up,
  delivering: ShipmentStatus.delivering,
  delivered: ShipmentStatus.delivered,
  failed: ShipmentStatus.retry_delivery,
  returning: ShipmentStatus.returning,
  returned: ShipmentStatus.returned,
};

/** Adapter mặc định: phí tính từ services_config, chưa gọi API hãng nào. */
export class ManualAdapter implements CarrierAdapter {
  quote(services: CarrierServiceConfig[], weightGrams: number): CarrierQuote[] {
    return services.map((s) => ({
      code: s.code,
      name: s.name,
      eta: s.eta,
      fee:
        s.base_fee +
        Math.max(0, Math.ceil(weightGrams / 500) - 1) * s.extra_fee_per_500g,
    }));
  }

  mapWebhookStatus(externalStatus: string): ShipmentStatus | null {
    return WEBHOOK_STATUS_MAP[externalStatus] ?? null;
  }
}
