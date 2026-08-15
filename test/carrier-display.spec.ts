/**
 * Tên đơn vị giao hàng hiển thị trên màn Đơn hàng / Vận đơn.
 * Chạy: npm test -- test/carrier-display.spec.ts
 */
import { carrierDisplayName } from '../src/modules/fulfillments/carrier-display';

describe('carrierDisplayName', () => {
  it('ưu tiên hãng tích hợp trong app', () => {
    expect(
      carrierDisplayName({
        provider: { name: 'Giao Hàng Nhanh' },
        carrierName: 'J&T Express',
        trackingCompany: 'Standard shipping',
      }),
    ).toBe('Giao Hàng Nhanh');
  });

  it('đơn từ sàn không có provider thì lấy tên hãng thật', () => {
    // Hình dạng thật của vận đơn TikTok/Shopee đồng bộ về: provider_id NULL
    expect(
      carrierDisplayName({
        provider: null,
        carrierName: 'J&T Express',
        trackingCompany: 'Standard shipping',
      }),
    ).toBe('J&T Express');
  });

  it('thiếu tên hãng thì lùi về tên dịch vụ vận chuyển', () => {
    expect(
      carrierDisplayName({
        provider: null,
        carrierName: null,
        trackingCompany: 'Standard shipping',
      }),
    ).toBe('Standard shipping');
  });

  it('chuỗi rỗng/khoảng trắng không được coi là có tên', () => {
    expect(
      carrierDisplayName({
        provider: null,
        carrierName: '   ',
        trackingCompany: '',
        carrier: 'other',
      }),
    ).toBe('other');
  });

  it('không có gì thì trả null để UI hiện dấu gạch', () => {
    expect(
      carrierDisplayName({
        provider: null,
        carrierName: null,
        trackingCompany: null,
        carrier: null,
      }),
    ).toBeNull();
  });

  it('bỏ qua field không truyền', () => {
    expect(carrierDisplayName({})).toBeNull();
  });
});
