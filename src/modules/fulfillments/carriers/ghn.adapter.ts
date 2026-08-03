import { ShipmentStatus, ShippingFeePayer } from '@prisma/client';
import {
  CarrierAdapter,
  CarrierQuote,
  CarrierServiceConfig,
} from './carrier-adapter';
import { ManualAdapter } from './manual.adapter';

/** GHN Status → trạng thái vận đơn nội bộ. null = bỏ qua (chưa cần đổi). */
const GHN_STATUS_MAP: Record<string, ShipmentStatus | null> = {
  ready_to_pick: null,
  picking: null,
  money_collect_picking: null,
  picked: ShipmentStatus.picked_up,
  storing: ShipmentStatus.picked_up,
  transporting: ShipmentStatus.delivering,
  sorting: ShipmentStatus.delivering,
  delivering: ShipmentStatus.delivering,
  money_collect_delivering: ShipmentStatus.delivering,
  delivered: ShipmentStatus.delivered,
  delivery_fail: ShipmentStatus.retry_delivery,
  waiting_to_return: ShipmentStatus.returning,
  return: ShipmentStatus.returning,
  return_transporting: ShipmentStatus.returning,
  return_sorting: ShipmentStatus.returning,
  returning: ShipmentStatus.returning,
  return_fail: ShipmentStatus.returning,
  returned: ShipmentStatus.returned,
  cancel: ShipmentStatus.cancelled,
  exception: ShipmentStatus.retry_delivery,
  damage: ShipmentStatus.retry_delivery,
  lost: ShipmentStatus.retry_delivery,
};

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

const REQUIRED_NOTE_MAP: Record<
  string,
  'CHOTHUHANG' | 'CHOXEMHANGKHONGTHU' | 'KHONGCHOXEMHANG'
> = {
  'Cho xem hàng, cho thử hàng': 'CHOTHUHANG',
  'Cho xem hàng, không cho thử': 'CHOXEMHANGKHONGTHU',
  'Không cho xem hàng': 'KHONGCHOXEMHANG',
};

/**
 * Adapter GHN: phí preview vẫn từ services_config (ManualAdapter);
 * status map + helper payload theo API GHN thật.
 */
export class GhnAdapter implements CarrierAdapter {
  private readonly fallback = new ManualAdapter();

  quote(services: CarrierServiceConfig[], weightGrams: number): CarrierQuote[] {
    return this.fallback.quote(services, weightGrams);
  }

  mapWebhookStatus(externalStatus: string): ShipmentStatus | null {
    const key = externalStatus.trim().toLowerCase();
    if (!(key in GHN_STATUS_MAP)) return null;
    return GHN_STATUS_MAP[key] ?? null;
  }

  /** true khi GHN báo cancel (kể cả khi map ra cancelled). */
  isCancelStatus(externalStatus: string): boolean {
    return externalStatus.trim().toLowerCase() === 'cancel';
  }

  mapRequiredNote(
    deliveryRequirement?: string | null,
  ): 'CHOTHUHANG' | 'CHOXEMHANGKHONGTHU' | 'KHONGCHOXEMHANG' {
    if (!deliveryRequirement) return 'KHONGCHOXEMHANG';
    return REQUIRED_NOTE_MAP[deliveryRequirement] ?? 'KHONGCHOXEMHANG';
  }

  mapPaymentTypeId(feePayer?: ShippingFeePayer | null): 1 | 2 {
    return feePayer === ShippingFeePayer.khach_tra ? 2 : 1;
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
}
