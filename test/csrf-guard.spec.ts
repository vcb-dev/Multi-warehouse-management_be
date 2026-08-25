/**
 * Chống CSRF cho luồng cookie.
 *
 * Đây là loại bảo vệ mà "chạy được" không chứng minh được gì: quên đăng ký guard hay nới
 * nhầm một điều kiện thì mọi thứ vẫn hoạt động y hệt, chỉ là lớp chặn không còn. Nên phải
 * test thẳng cả hai chiều — chặn đúng cái cần chặn, và KHÔNG chặn nhầm webhook đối tác.
 */
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { CsrfGuard } from '../src/common/guards/csrf.guard';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../src/common/auth/cookies';

const ALLOWED = 'https://app.vienchibao.vn';

type Req = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string | undefined>;
};

function ctx(req: Req): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: {}, cookies: {}, ...req }),
    }),
  } as unknown as ExecutionContext;
}

const guard = new CsrfGuard();
const run = (req: Req) => guard.canActivate(ctx(req));

/** Request thật của FE: cookie phiên + origin hợp lệ + header do mã app đặt. */
const fromApp = (over: Req = {}): Req => ({
  method: 'POST',
  headers: { origin: ALLOWED, 'x-requested-with': 'XMLHttpRequest' },
  cookies: { [ACCESS_COOKIE]: 'a.jwt' },
  ...over,
});

beforeEach(() => {
  process.env.CORS_ORIGIN = ALLOWED;
});
afterEach(() => {
  delete process.env.CORS_ORIGIN;
});

describe('cho đi', () => {
  it('request bình thường của FE', () => {
    expect(run(fromApp())).toBe(true);
  });

  it('GET có cookie — đọc thì giả mạo cũng vô hại', () => {
    expect(
      run({
        method: 'GET',
        headers: { origin: 'https://evil.test' },
        cookies: { [ACCESS_COOKIE]: 'a.jwt' },
      }),
    ).toBe(true);
  });

  it('webhook đối tác: POST không cookie, không header, origin lạ', () => {
    // GHN/TikTok/Shopee gọi từ server của họ. Chặn nhầm nhóm này là đơn hàng ngừng cập
    // nhật trạng thái mà không ai thấy lỗi ở đâu — chúng tự xác thực bằng secret riêng.
    expect(
      run({ method: 'POST', headers: { origin: 'https://partner.test' } }),
    ).toBe(true);
  });

  it('client dùng x-api-key / Bearer — trình duyệt không tự gắn hai thứ đó', () => {
    expect(
      run({ method: 'POST', headers: { 'x-api-key': 'whk_live_x' } }),
    ).toBe(true);
  });

  it('origin vắng mặt (curl, script) nhưng có header', () => {
    expect(run(fromApp({ headers: { 'x-requested-with': 'x' } }))).toBe(true);
  });
});

describe('chặn lại', () => {
  it('form POST từ site lạ: có cookie, origin sai', () => {
    expect(() =>
      run(
        fromApp({
          headers: { origin: 'https://evil.test', 'x-requested-with': 'x' },
        }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('có cookie, origin đúng nhưng thiếu header', () => {
    // Form thường không preflight nên đặt được `Content-Type` hợp lệ mà vẫn tới nơi —
    // header tự chế là thứ duy nhất nó không giả được.
    expect(() => run(fromApp({ headers: { origin: ALLOWED } }))).toThrow(
      ForbiddenException,
    );
  });

  it('chỉ có refresh cookie (đường /auth/refresh, /auth/logout) cũng bị soi', () => {
    // Hai route đó là `@Public()` nhưng vẫn đổi trạng thái phiên bằng chính cookie.
    expect(() =>
      run({
        method: 'POST',
        headers: { origin: 'https://evil.test' },
        cookies: { [REFRESH_COOKIE]: 'r.jwt' },
      }),
    ).toThrow(ForbiddenException);
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('%s cũng bị soi như POST', (method) => {
    expect(() =>
      run(fromApp({ method, headers: { origin: ALLOWED } })),
    ).toThrow(ForbiddenException);
  });
});
