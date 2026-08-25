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
  it('CHẾT lúc khởi động ở mọi môi trường, kể cả dev', () => {
    // Không còn mặc định localhost để rơi về: một danh sách viết cứng trong code sẽ nuốt
    // mất lỗi quên khai env, và triệu chứng lộ ra sau đó là "đăng nhập xong mọi request
    // vẫn 401" chứ không phải lỗi CORS dễ thấy.
    process.env.NODE_ENV = 'development';
    expect(() => allowedOrigins()).toThrow(/CORS_ORIGIN/);

    process.env.NODE_ENV = 'production';
    expect(() => allowedOrigins()).toThrow(/CORS_ORIGIN/);
  });

  it('có cấu hình -> chạy bình thường', () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ORIGIN = 'https://app.test';
    expect(allowedOrigins()).toEqual(['https://app.test']);
  });
});

describe('giá trị gõ sai', () => {
  // Origin sai không bao giờ ném lỗi lúc so khớp — nó chỉ lặng lẽ không khớp. Bắt tại
  // lúc khởi động là cách duy nhất để nó không đội lốt lỗi xác thực.
  it('thiếu scheme', () => {
    process.env.CORS_ORIGIN = 'localhost:4002';
    expect(() => allowedOrigins()).toThrow(/không hợp lệ/);
  });

  it('dính đường dẫn khi copy từ thanh địa chỉ', () => {
    process.env.CORS_ORIGIN = 'https://app.test/dashboard';
    expect(() => allowedOrigins()).toThrow(/https:\/\/app\.test/);
  });

  it('* — vô hiệu với credentials: true', () => {
    process.env.CORS_ORIGIN = '*';
    expect(() => allowedOrigins()).toThrow(/credentials/);
  });

  it('một giá trị hỏng làm hỏng cả danh sách, không im lặng bỏ qua', () => {
    process.env.CORS_ORIGIN = 'https://a.test,ftp://b.test';
    expect(() => allowedOrigins()).toThrow(/http/);
  });
});
