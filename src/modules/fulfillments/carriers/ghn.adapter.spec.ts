import { ShipmentStatus } from '@prisma/client';
import { GhnAdapter } from './ghn.adapter';

describe('GhnAdapter', () => {
  const adapter = new GhnAdapter();

  it('maps GHN statuses to internal shipment statuses', () => {
    expect(adapter.mapWebhookStatus('ready_to_pick')).toBeNull();
    expect(adapter.mapWebhookStatus('picking')).toBeNull();
    expect(adapter.mapWebhookStatus('picked')).toBe(ShipmentStatus.picked_up);
    expect(adapter.mapWebhookStatus('delivering')).toBe(
      ShipmentStatus.delivering,
    );
    expect(adapter.mapWebhookStatus('delivered')).toBe(
      ShipmentStatus.delivered,
    );
    expect(adapter.mapWebhookStatus('delivery_fail')).toBe(
      ShipmentStatus.retry_delivery,
    );
    expect(adapter.mapWebhookStatus('returned')).toBe(ShipmentStatus.returned);
    expect(adapter.mapWebhookStatus('cancel')).toBe(ShipmentStatus.cancelled);
    expect(adapter.mapWebhookStatus('unknown_xyz')).toBeNull();
  });

  it('builds transition path across skipped GHN statuses', () => {
    expect(
      adapter.pathTo(ShipmentStatus.pending, ShipmentStatus.delivering),
    ).toEqual([ShipmentStatus.picked_up, ShipmentStatus.delivering]);
    expect(
      adapter.pathTo(ShipmentStatus.pending, ShipmentStatus.delivered),
    ).toEqual([
      ShipmentStatus.picked_up,
      ShipmentStatus.delivering,
      ShipmentStatus.delivered,
    ]);
    expect(
      adapter.pathTo(ShipmentStatus.delivering, ShipmentStatus.returned),
    ).toEqual([
      ShipmentStatus.retry_delivery,
      ShipmentStatus.returning,
      ShipmentStatus.returned,
    ]);
    expect(
      adapter.pathTo(ShipmentStatus.pending, ShipmentStatus.pending),
    ).toEqual([]);
  });

  it('maps delivery requirement and fee payer', () => {
    expect(adapter.mapRequiredNote('Cho xem hàng, cho thử hàng')).toBe(
      'CHOTHUHANG',
    );
    expect(adapter.mapRequiredNote('Không cho xem hàng')).toBe(
      'KHONGCHOXEMHANG',
    );
    expect(adapter.mapRequiredNote(null)).toBe('KHONGCHOXEMHANG');
    expect(adapter.mapPaymentTypeId('khach_tra')).toBe(2);
    expect(adapter.mapPaymentTypeId('shop_tra')).toBe(1);
  });
});
