/**
 * Đồng bộ đơn TikTok — hai quy tắc dễ làm sai của `tiktok-order-sync.service.ts`:
 * map địa chỉ người nhận (bị che một phần) và điều kiện được phép thay dòng hàng.
 * Chạy: npm test -- test/tiktok-order-sync.spec.ts
 *
 * Các payload dưới đây chép nguyên từ dữ liệu thật (đo 2026-08-18), kể cả phần bị TikTok
 * che bằng dấu `*` — không rút gọn, vì chính hình dạng lệch lạc của nó là thứ cần khoá lại.
 */
import {
  mapRecipientAddress,
  shouldReplaceLineItems,
} from '../src/modules/channels/tiktok/tiktok-order-sync.service';
import type { TiktokOrder } from '../src/modules/channels/tiktok/tiktok-api.client';

const order = (recipient: TiktokOrder['recipient_address']): TiktokOrder =>
  ({ id: '585553267735955433', recipient_address: recipient }) as TiktokOrder;

describe('mapRecipientAddress', () => {
  it('giữ nguyên phần bị che, lấy đúng tỉnh/quận không bị che', () => {
    expect(
      mapRecipientAddress(
        order({
          name: 'đ** đ** q***g',
          phone_number: '(+84)947****98',
          address_detail: 'Ph********************',
          address_line1: 'Ph**************',
          region_code: 'VN',
          district_info: [
            { address_level: 'L0', address_level_name: 'Country', address_name: 'Việt Nam', iso_code: 'VN' },
            { address_level: 'L1', address_level_name: 'city', address_name: 'Hải Phòng', iso_code: 'HP' },
            { address_level: 'L2', address_level_name: 'district', address_name: 'Tiên Lãng' },
            { address_level: 'L3', address_level_name: 'ward', address_name: 'Bạ*******' },
          ],
        }),
      ),
    ).toEqual({
      shippingName: 'đ** đ** q***g',
      shippingPhone: '0947****98',
      shippingAddress1: 'Ph********************',
      shippingWard: 'Bạ*******',
      shippingDistrict: 'Tiên Lãng',
      shippingProvince: 'Hải Phòng',
      shippingProvinceCode: 'HP',
      shippingCountry: 'Việt Nam',
      shippingCountryCode: 'VN',
    });
  });

  it('phân cấp theo L0..L3 chứ không theo tên cấp', () => {
    // Sau đợt gộp đơn vị hành chính, TikTok gọi cấp L2 là 'city' chứ không phải 'district'
    // — bắt theo tên cấp sẽ để trống cột quận/huyện ở đúng những đơn này.
    const r = mapRecipientAddress(
      order({
        district_info: [
          { address_level: 'L1', address_level_name: 'city', address_name: 'Hà Nội', iso_code: 'HN' },
          { address_level: 'L2', address_level_name: 'city', address_name: 'Phường Hai Bà Trưng' },
          { address_level: 'L3', address_level_name: 'ward', address_name: 'Ph*****************' },
        ],
      }),
    );
    expect(r).toMatchObject({
      shippingProvince: 'Hà Nội',
      shippingDistrict: 'Phường Hai Bà Trưng',
      shippingWard: 'Ph*****************',
    });
  });

  it('đơn bị giữ trả object rỗng thì không ghi đè địa chỉ đã có', () => {
    // `{}` chứ không phải loạt `null`: nhánh update dùng chung object này, ghi null vào là
    // xoá mất địa chỉ lấy được ở lần đồng bộ trước.
    expect(
      mapRecipientAddress(
        order({
          name: '',
          phone_number: '',
          address_detail: '',
          full_address: '',
          district_info: [],
        }),
      ),
    ).toEqual({});
    expect(mapRecipientAddress(order(undefined))).toEqual({});
  });

  it('không có tiền tố +84 thì để nguyên', () => {
    expect(
      mapRecipientAddress(order({ phone_number: '036*****68' })).shippingPhone,
    ).toBe('036*****68');
  });

  it('không thêm số 0 vào số đã có sẵn 0 sau mã vùng', () => {
    // Cả hai dạng đều gặp trên dữ liệu thật cùng một ngày
    expect(
      mapRecipientAddress(order({ phone_number: '(+84)096*****31' }))
        .shippingPhone,
    ).toBe('096*****31');
    expect(
      mapRecipientAddress(order({ phone_number: '(+84)947****98' }))
        .shippingPhone,
    ).toBe('0947****98');
  });
});

/**
 * Quy tắc giữ dòng hàng khi khớp SKU chưa đủ. Có test riêng vì đây là chỗ đã gây mất dữ
 * liệu thật: 90 đơn bị xoá sạch dòng hàng trước khi phát hiện (đo 2026-08-18).
 */
describe('shouldReplaceLineItems', () => {
  it('khớp đủ thì thay cả cụm', () => {
    expect(shouldReplaceLineItems(0, 3)).toBe(true);
  });

  it('khớp thiếu thì GIỮ dòng cũ, không xoá', () => {
    // Đây là ca đã làm mất dữ liệu: TikTok báo 3 dòng, chỉ khớp được 2 SKU
    expect(shouldReplaceLineItems(1, 2)).toBe(false);
  });

  it('không khớp dòng nào thì giữ nguyên', () => {
    expect(shouldReplaceLineItems(3, 0)).toBe(false);
  });

  it('TikTok trả đơn không có dòng nào thì cũng không được xoá', () => {
    expect(shouldReplaceLineItems(0, 0)).toBe(false);
  });
});
