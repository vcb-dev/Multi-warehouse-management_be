import { phoneSearchDigits } from './unaccent-search';

/**
 * `customers.phone` lưu `+84…` còn người dùng gõ/paste `0…`: mọi cách viết của
 * cùng một số phải ra cùng một chuỗi số, không thì tìm khách đã có sẽ ra 0 dòng
 * và người dùng tạo trùng khách.
 */
describe('phoneSearchDigits', () => {
  it('mọi cách viết đầu số của cùng một số cho cùng một chuỗi', () => {
    for (const raw of [
      '0397679424',
      '84397679424',
      '+84397679424',
      '+84 397 679 424',
      '397679424',
      '039.767.9424',
      ' 0397679424 ',
    ]) {
      expect(phoneSearchDigits(raw)).toBe('397679424');
    }
  });

  it('gõ dở vài số đầu vẫn tìm được', () => {
    expect(phoneSearchDigits('0397')).toBe('397');
    expect(phoneSearchDigits('039767')).toBe('39767');
  });

  it('bỏ qua từ khoá không phải SĐT', () => {
    expect(phoneSearchDigits('Yến Ngọc')).toBeNull();
    expect(phoneSearchDigits('')).toBeNull();
    expect(phoneSearchDigits('039')).toBeNull();
  });

  it('giữ nguyên số quốc tế khác 84', () => {
    expect(phoneSearchDigits('+12048807865')).toBe('12048807865');
  });
});
