/**
 * Trạng thái đóng gói của vận đơn đơn sàn khi đồng bộ — hàm thuần, không đụng DB.
 */
import { syncedPackedStatus } from '../src/modules/channels/marketplace-packing';

describe('syncedPackedStatus', () => {
  it('kiện mới còn chờ lấy hàng bắt đầu ở "chờ đóng gói"', () => {
    expect(syncedPackedStatus('pending', null)).toBe('unknown');
    expect(syncedPackedStatus(null, undefined)).toBe('unknown');
  });

  it.each(['unknown', 'packing', 'packed'] as const)(
    'đồng bộ lại không ghi đè thao tác của kho (%s)',
    (current) => {
      expect(syncedPackedStatus('pending', current)).toBe(current);
    },
  );

  it.each(['picked_up', 'delivering', 'delivered', 'returning'] as const)(
    'hãng đã cầm hàng (%s) thì coi như đã đóng gói dù kho chưa bấm',
    (shipment) => {
      expect(syncedPackedStatus(shipment, 'unknown')).toBe('packed');
      expect(syncedPackedStatus(shipment, null)).toBe('packed');
    },
  );

  it('đơn huỷ giữ nguyên trạng thái kho đã ghi', () => {
    expect(syncedPackedStatus('cancelled', 'packing')).toBe('packing');
    expect(syncedPackedStatus('cancelled', null)).toBe('unknown');
  });
});
