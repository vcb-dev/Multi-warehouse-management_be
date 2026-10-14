import { variantImageUrl } from '../src/common/utils/variant-image';

describe('variantImageUrl', () => {
  it('ưu tiên ảnh riêng của phiên bản', () => {
    expect(
      variantImageUrl({ imageUrl: 'v.jpg', product: { imageUrl: 'p.jpg' } }),
    ).toBe('v.jpg');
  });

  it('phiên bản không có ảnh thì lấy ảnh sản phẩm', () => {
    expect(
      variantImageUrl({ imageUrl: null, product: { imageUrl: 'p.jpg' } }),
    ).toBe('p.jpg');
  });

  it('không có gì thì trả null, kể cả khi thiếu hẳn variant', () => {
    expect(variantImageUrl({ imageUrl: null, product: null })).toBeNull();
    expect(variantImageUrl(undefined)).toBeNull();
  });
});
