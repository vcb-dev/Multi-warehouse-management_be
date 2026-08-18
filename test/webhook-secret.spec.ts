/**
 * Xác thực webhook của hãng vận chuyển.
 *
 * Những endpoint này đi qua `@Public` nên đây là lớp bảo vệ DUY NHẤT. Luật cốt lõi:
 * thiếu cấu hình thì ĐÓNG, không phải mở — bản cũ chỉ kiểm "nếu có đặt env", nghĩa là
 * quên đặt biến là ai cũng đẩy được trạng thái vận đơn giả, kéo theo hủy vận đơn và
 * hoàn tồn kho.
 */
import { UnauthorizedException } from '@nestjs/common';
import { assertWebhookSecret } from '../src/common/auth/webhook-secret';

const KEY = 'TEST_WEBHOOK_SECRET';
const SECRET = 'super-secret-value';

describe('assertWebhookSecret', () => {
  const original = process.env[KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it('CHƯA cấu hình env -> từ chối, không phải cho qua', () => {
    delete process.env[KEY];
    expect(() => assertWebhookSecret(KEY, SECRET)).toThrow(
      UnauthorizedException,
    );
  });

  it('env rỗng hoặc chỉ khoảng trắng cũng tính là chưa cấu hình', () => {
    process.env[KEY] = '   ';
    expect(() => assertWebhookSecret(KEY, SECRET)).toThrow(
      UnauthorizedException,
    );
  });

  it('thông báo lỗi nói rõ thiếu biến nào — để người vận hành sửa được', () => {
    delete process.env[KEY];
    expect(() => assertWebhookSecret(KEY, 'bat-ky')).toThrow(
      new RegExp(KEY),
    );
  });

  it('khớp -> cho qua', () => {
    process.env[KEY] = SECRET;
    expect(() => assertWebhookSecret(KEY, SECRET)).not.toThrow();
  });

  it('bỏ khoảng trắng thừa hai đầu của env', () => {
    process.env[KEY] = `  ${SECRET}  `;
    expect(() => assertWebhookSecret(KEY, SECRET)).not.toThrow();
  });

  it('sai -> từ chối', () => {
    process.env[KEY] = SECRET;
    expect(() => assertWebhookSecret(KEY, 'sai-be-bet')).toThrow(
      UnauthorizedException,
    );
  });

  it('khớp MỘT trong nhiều vị trí là đủ (ViettelPost: header hoặc body)', () => {
    // Tài liệu VTP không nói rõ secret nằm ở header `Authorization` hay field
    // `TOKEN` trong body, nên nhận cả hai.
    process.env[KEY] = SECRET;
    expect(() => assertWebhookSecret(KEY, undefined, SECRET)).not.toThrow();
    expect(() => assertWebhookSecret(KEY, SECRET, undefined)).not.toThrow();
  });

  it('không truyền vị trí nào -> từ chối', () => {
    process.env[KEY] = SECRET;
    expect(() => assertWebhookSecret(KEY)).toThrow(UnauthorizedException);
  });

  it('chuỗi rỗng không được coi là khớp dù env cũng rỗng-sau-trim', () => {
    // Chốt chặn cho lỗi kinh điển: '' === '' cho qua nhầm.
    process.env[KEY] = SECRET;
    expect(() => assertWebhookSecret(KEY, '')).toThrow(UnauthorizedException);
  });
});
