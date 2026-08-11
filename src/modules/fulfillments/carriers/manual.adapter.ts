import { ShipmentStatus } from '@prisma/client';
import {
  CarrierAdapter,
  CarrierQuote,
  CarrierServiceConfig,
  estimateQuote,
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
  quote(
    services: CarrierServiceConfig[],
    weightGrams: number,
  ): Promise<CarrierQuote[]> {
    return Promise.resolve(estimateQuote(services, weightGrams));
  }

  mapWebhookStatus(externalStatus: string): ShipmentStatus | null {
    return WEBHOOK_STATUS_MAP[externalStatus] ?? null;
  }
}
