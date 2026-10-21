import { carrierTrackingUrl } from '../src/modules/fulfillments/carrier-display';

describe('carrierTrackingUrl — link xem hành trình vận đơn', () => {
  const vtpLink =
    'https://viettelpost.vn/thong-tin-don-hang?peopleTracking=sender&orderNumber=155166399786';

  it('ưu tiên tracking_url đã lưu (Sapo/sàn trả về)', () => {
    expect(
      carrierTrackingUrl({
        trackingUrl: 'https://jtexpress.vn/tracking?type=track&billcode=1',
        trackingNumber: '1',
        carrier: 'VIETTEL_POST',
      }),
    ).toBe('https://jtexpress.vn/tracking?type=track&billcode=1');
  });

  it('dựng link VTP khi chưa lưu — nhận theo mã provider, carrier hoặc tên hãng', () => {
    const trackingNumber = '155166399786';
    expect(carrierTrackingUrl({ trackingNumber, provider: { code: 'viettel_post' } })).toBe(vtpLink);
    expect(carrierTrackingUrl({ trackingNumber, carrier: 'VIETTEL_POST' })).toBe(vtpLink);
    expect(carrierTrackingUrl({ trackingNumber, carrierName: 'Viettel Post' })).toBe(vtpLink);
  });

  it('không có mã vận đơn hoặc hãng khác thì không có link', () => {
    expect(carrierTrackingUrl({ trackingNumber: null, carrier: 'VIETTEL_POST' })).toBeNull();
    expect(carrierTrackingUrl({ trackingNumber: '123', provider: { code: 'ghtk' } })).toBeNull();
  });
});
