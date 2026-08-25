/**
 * Danh sách origin. Cấu hình sai ở đây không ra lỗi CORS dễ thấy — nó ra "đăng nhập xong
 * request nào cũng 401", vì trình duyệt lặng lẽ bỏ cookie lại.
 */
import {
  allowedOrigins,
  isAllowedOrigin,
} from '../src/common/http/cors-origins';

const ORIGINAL_ENV = process.env.NODE_ENV;

afterEach(() => {
  delete process.env.CORS_ORIGIN;
  process.env.NODE_ENV = ORIGINAL_ENV;
});

describe('đọc CORS_ORIGIN', () => {
  it('tách theo dấu phẩy, bỏ khoảng trắng thừa', () => {
    process.env.CORS_ORIGIN = ' https://a.test , https://b.test ';
    expect(allowedOrigins()).toEqual(['https://a.test', 'https://b.test']);
  });

  it('bỏ dấu / cuối — trình duyệt không bao giờ gửi kèm nó', () => {
    // Dán URL từ thanh địa chỉ là dính dấu này, và một ký tự thừa đủ để trượt so khớp.
    process.env.CORS_ORIGIN = 'https://a.test/';
    expect(isAllowedOrigin('https://a.test')).toBe(true);
  });

  it('so khớp nguyên origin, không phải tiền tố', () => {
    process.env.CORS_ORIGIN = 'https://app.test';
    expect(isAllowedOrigin('https://app.test.evil.com')).toBe(false);
    expect(isAllowedOrigin('https://evil.com')).toBe(false);
  });
});

describe('thiếu cấu hình', () => {
  it('dev: rơi về localhost để chạy được ngay', () => {
    process.env.NODE_ENV = 'development';
    expect(allowedOrigins()).toContain('http://localhost:4002');
  });

  it('production: CHẾT lúc khởi động thay vì rơi về localhost', () => {
    // Rơi về localhost trên môi trường thật = mọi request từ domain thật mất cookie. Một
    // lỗi cấu hình đội lốt lỗi xác thực, tốn hàng giờ để lần ra.
    process.env.NODE_ENV = 'production';
    expect(() => allowedOrigins()).toThrow(/CORS_ORIGIN/);
  });

  it('production nhưng có cấu hình -> chạy bình thường', () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ORIGIN = 'https://app.test';
    expect(allowedOrigins()).toEqual(['https://app.test']);
  });
});
