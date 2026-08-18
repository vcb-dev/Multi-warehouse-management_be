/**
 * Cấu hình giới hạn tần suất.
 *
 * Đây là loại code hỏng trong im lặng: sai tiền tố đường dẫn hay sai cách dựng khoá
 * đếm thì không có lỗi, không có log — chỉ là bảo vệ ngừng hoạt động mà không ai biết.
 * Nên phải test thẳng `skipIf`/`getTracker` thay vì tin vào việc đọc lại code.
 */
import type { ExecutionContext } from '@nestjs/common';
import {
  LOGIN_PATH,
  apiKeyThrottler,
  loginThrottler,
  throttlerDefinitions,
  type ThrottleRequest,
} from '../src/common/throttler/throttler.config';

function ctx(req: Partial<ThrottleRequest>): ExecutionContext {
  const full: ThrottleRequest = { headers: {}, ...req };
  return {
    switchToHttp: () => ({ getRequest: () => full }),
  } as unknown as ExecutionContext;
}

const skipApiKey = (req: Partial<ThrottleRequest>) =>
  apiKeyThrottler.skipIf!(ctx(req));
const skipLogin = (req: Partial<ThrottleRequest>) =>
  loginThrottler.skipIf!(ctx(req));
const track = (req: Partial<ThrottleRequest>) =>
  (loginThrottler.getTracker as (r: ThrottleRequest) => string)({
    headers: {},
    ...req,
  });

describe('bộ đếm cho đối tác (x-api-key)', () => {
  it('có x-api-key -> ĐẾM', () => {
    expect(skipApiKey({ headers: { 'x-api-key': 'whk_live_x' } })).toBe(false);
  });

  it('không có x-api-key -> bỏ qua, traffic JWT nội bộ không bị chặn', () => {
    expect(skipApiKey({ headers: {} })).toBe(true);
  });
});

describe('bộ đếm cho đăng nhập', () => {
  it('đúng đường đăng nhập -> ĐẾM', () => {
    expect(skipLogin({ url: LOGIN_PATH })).toBe(false);
  });

  it('có query string vẫn ĐẾM', () => {
    expect(skipLogin({ url: `${LOGIN_PATH}?redirect=/don-hang` })).toBe(false);
  });

  it('đường khác -> bỏ qua', () => {
    expect(skipLogin({ url: '/api/orders' })).toBe(true);
    expect(skipLogin({ url: '/api/auth/me' })).toBe(true);
  });

  it('không có url -> bỏ qua thay vì nổ', () => {
    expect(skipLogin({})).toBe(true);
  });

  it('đường dẫn phải mang tiền tố /api của setGlobalPrefix', () => {
    // Chốt lại điều dễ sai nhất: thiếu /api là bộ đếm không bao giờ chạy.
    expect(LOGIN_PATH).toBe('/api/auth/login');
    expect(skipLogin({ url: '/auth/login' })).toBe(true);
  });
});

describe('khoá đếm của đăng nhập', () => {
  it('gộp IP với email', () => {
    expect(track({ ip: '1.2.3.4', body: { email: 'a@b.com' } })).toBe(
      '1.2.3.4|a@b.com',
    );
  });

  it('email khác nhau -> khoá khác nhau, cùng IP không đá nhau', () => {
    // Cả phòng ngồi sau một IP: một người gõ sai mật khẩu không được khoá người khác.
    const a = track({ ip: '1.2.3.4', body: { email: 'a@b.com' } });
    const b = track({ ip: '1.2.3.4', body: { email: 'c@d.com' } });
    expect(a).not.toBe(b);
  });

  it('cùng email từ IP khác -> khoá khác, không cộng dồn xuyên mạng', () => {
    const a = track({ ip: '1.1.1.1', body: { email: 'a@b.com' } });
    const b = track({ ip: '2.2.2.2', body: { email: 'a@b.com' } });
    expect(a).not.toBe(b);
  });

  it('chuẩn hoá hoa/thường và khoảng trắng — không né được bằng cách đổi cách gõ', () => {
    expect(track({ ip: '1.2.3.4', body: { email: '  A@B.CoM ' } })).toBe(
      '1.2.3.4|a@b.com',
    );
  });

  it('không có email -> rơi về đếm theo IP', () => {
    expect(track({ ip: '1.2.3.4', body: {} })).toBe('1.2.3.4');
    expect(track({ ip: '1.2.3.4' })).toBe('1.2.3.4');
  });

  it('email không phải chuỗi -> không nổ, vẫn ra khoá dùng được', () => {
    expect(track({ ip: '1.2.3.4', body: { email: { $ne: null } } })).toBe(
      '1.2.3.4|[object object]',
    );
    expect(track({ ip: '1.2.3.4', body: { email: 123 } })).toBe('1.2.3.4|123');
  });

  it('thiếu cả ip -> vẫn ra khoá, không trả undefined', () => {
    expect(track({})).toBe('unknown');
  });
});

describe('bộ định nghĩa đăng ký vào module', () => {
  it('đăng ký đủ cả hai, tên không trùng nhau', () => {
    expect(throttlerDefinitions).toHaveLength(2);
    const names = throttlerDefinitions.map((d) => d.name);
    expect(new Set(names).size).toBe(2);
    expect(names).toEqual(['default', 'auth']);
  });

  it('đăng nhập siết chặt hơn nhiều so với đối tác', () => {
    expect(loginThrottler.limit).toBeLessThan(apiKeyThrottler.limit as number);
  });
});
