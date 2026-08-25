/**
 * Cookie mang access/refresh token.
 *
 * Chỗ này hỏng theo kiểu im lặng đến khó chịu: sai một thuộc tính là trình duyệt lặng lẽ
 * không gửi cookie (hoặc không xoá được nó), còn triệu chứng thì hiện ra ở tận nơi khác
 * dưới dạng "đăng nhập xong mọi request vẫn 401" hay "bấm đăng xuất mà vẫn còn phiên".
 */
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  assertAuthCookieConfig,
  clearAuthCookies,
  setAuthCookies,
} from '../src/common/auth/cookies';
import type { Response } from 'express';

type Call = { name: string; value?: string; options: Record<string, unknown> };

function fakeRes() {
  const set: Call[] = [];
  const cleared: Call[] = [];
  const res = {
    cookie: jest.fn(
      (name: string, value: string, options: Record<string, unknown>) => {
        set.push({ name, value, options });
      },
    ),
    clearCookie: jest.fn((name: string, options: Record<string, unknown>) => {
      cleared.push({ name, options });
    }),
  } as unknown as Response;
  return {
    res,
    set,
    cleared,
    setOf: (n: string) => set.find((c) => c.name === n)!,
    clearedOf: (n: string) => cleared.find((c) => c.name === n)!,
  };
}

const tokens = {
  accessToken: 'access.jwt',
  accessExpiresAt: new Date('2026-08-22T00:15:00.000Z'),
  refreshToken: 'refresh.jwt',
  refreshExpiresAt: new Date('2026-08-29T00:00:00.000Z'),
};

const ENV_KEYS = [
  'AUTH_COOKIE_SAMESITE',
  'AUTH_COOKIE_SECURE',
  'AUTH_COOKIE_DOMAIN',
  'NODE_ENV',
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('đặt cookie', () => {
  it('cả hai token đều httpOnly — JavaScript của trang không đọc được', () => {
    const { res, setOf } = fakeRes();
    setAuthCookies(res, tokens);
    expect(setOf(ACCESS_COOKIE).options.httpOnly).toBe(true);
    expect(setOf(REFRESH_COOKIE).options.httpOnly).toBe(true);
  });

  it('refresh cookie chỉ gửi cho /api/auth, access cookie gửi mọi nơi', () => {
    // Thu hẹp bề mặt: request nghiệp vụ bình thường không mang refresh token đi theo, nên
    // một endpoint rò header cũng không làm lộ đường gia hạn 7 ngày.
    const { res, setOf } = fakeRes();
    setAuthCookies(res, tokens);
    expect(setOf(ACCESS_COOKIE).options.path).toBe('/');
    expect(setOf(REFRESH_COOKIE).options.path).toBe('/api/auth');
  });

  it('hạn cookie khớp hạn token — refresh sống lâu hơn access', () => {
    const { res, setOf } = fakeRes();
    setAuthCookies(res, tokens);
    expect(setOf(ACCESS_COOKIE).options.expires).toEqual(
      tokens.accessExpiresAt,
    );
    expect(setOf(REFRESH_COOKIE).options.expires).toEqual(
      tokens.refreshExpiresAt,
    );
  });

  it('mặc định SameSite=Lax — chặn POST/fetch cross-site, vẫn để ngỏ link từ email', () => {
    // `lax` chặn đúng vector CSRF chính. `strict` chặt hơn ở chỗ chặn thêm điều hướng GET
    // từ site khác, nhưng phần thêm đó cũng chính là thứ làm hỏng link email trỏ thẳng
    // vào endpoint API — chọn `lax` để không khoá trước cánh cửa đó.
    const { res, setOf } = fakeRes();
    setAuthCookies(res, tokens);
    expect(setOf(ACCESS_COOKIE).options.sameSite).toBe('lax');
  });

  it.each(['strict', 'none'])(
    'khai "%s" tường minh thì vẫn được tôn trọng',
    (value) => {
      // Deploy khác tên miền gốc BẮT BUỘC dùng `none` — mặc định chặt hơn không được
      // phép chặn mất đường đó.
      process.env.AUTH_COOKIE_SAMESITE = value;
      const { res, setOf } = fakeRes();
      setAuthCookies(res, tokens);
      expect(setOf(ACCESS_COOKIE).options.sameSite).toBe(value);
    },
  );

  it('SameSite=None mà không khai Secure thì Secure tự bật', () => {
    // Trình duyệt vứt thẳng cookie `SameSite=None` không kèm `Secure`, nên đây là suy diễn
    // an toàn: không khai gì nghĩa là không có ý kiến, và chỉ có một giá trị chạy được.
    process.env.AUTH_COOKIE_SAMESITE = 'none';
    const { res, setOf } = fakeRes();
    setAuthCookies(res, tokens);
    expect(setOf(ACCESS_COOKIE).options.sameSite).toBe('none');
    expect(setOf(ACCESS_COOKIE).options.secure).toBe(true);
  });

  it('SameSite=None + AUTH_COOKIE_SECURE=false thì ném lỗi, không âm thầm sửa lưng', () => {
    // Cấu hình này không có cách nào chạy đúng. Lặng lẽ trả về `true` thì `.env` nói một
    // đằng còn hệ thống chạy một nẻo — người đọc file cấu hình để dò bug sẽ tin nhầm.
    process.env.AUTH_COOKIE_SAMESITE = 'none';
    process.env.AUTH_COOKIE_SECURE = 'false';
    const { res } = fakeRes();
    expect(() => setAuthCookies(res, tokens)).toThrow(/AUTH_COOKIE_SECURE/);
  });

  it('assertAuthCookieConfig bắt cấu hình mâu thuẫn ngay lúc khởi động', () => {
    // `main.ts` gọi hàm này trước khi mở cổng: chết lúc boot rẻ hơn nhiều so với chết ở
    // lượt đăng nhập đầu tiên trên môi trường thật.
    process.env.AUTH_COOKIE_SAMESITE = 'none';
    process.env.AUTH_COOKIE_SECURE = 'false';
    expect(() => assertAuthCookieConfig()).toThrow(/AUTH_COOKIE_SECURE/);
  });

  it('cấu hình hợp lệ thì assertAuthCookieConfig im lặng cho qua', () => {
    process.env.AUTH_COOKIE_SAMESITE = 'lax';
    process.env.AUTH_COOKIE_SECURE = 'false';
    expect(() => assertAuthCookieConfig()).not.toThrow();
  });

  it('production mặc định Secure ngay cả khi không khai gì', () => {
    process.env.NODE_ENV = 'production';
    const { res, setOf } = fakeRes();
    setAuthCookies(res, tokens);
    expect(setOf(ACCESS_COOKIE).options.secure).toBe(true);
  });

  it.each(['yes-please', '', '  ', 'None ', 'STRICT', 'lax'])(
    'giá trị SameSite "%s" không lọt thẳng vào header',
    (raw) => {
      // Express ném `TypeError` với giá trị lạ, và nó ném lúc CÓ NGƯỜI ĐĂNG NHẬP chứ
      // không phải lúc khởi động — nên phải chặn ở đây. Giá trị hợp lệ viết hoa hay dính
      // khoảng trắng (rất hay gặp khi copy từ dashboard) thì vẫn phải nhận.
      process.env.AUTH_COOKIE_SAMESITE = raw;
      const { res, setOf } = fakeRes();
      setAuthCookies(res, tokens);
      const expected = raw.trim().toLowerCase();
      expect(setOf(ACCESS_COOKIE).options.sameSite).toBe(
        ['lax', 'strict', 'none'].includes(expected) ? expected : 'lax',
      );
    },
  );

  it('không tự đặt domain — sai domain là cookie im lặng không được gửi', () => {
    const { res, setOf } = fakeRes();
    setAuthCookies(res, tokens);
    expect(setOf(ACCESS_COOKIE).options).not.toHaveProperty('domain');
  });

  it('có khai domain thì áp cho cả hai cookie', () => {
    process.env.AUTH_COOKIE_DOMAIN = '.vienchibao.vn';
    const { res, setOf } = fakeRes();
    setAuthCookies(res, tokens);
    expect(setOf(ACCESS_COOKIE).options.domain).toBe('.vienchibao.vn');
    expect(setOf(REFRESH_COOKIE).options.domain).toBe('.vienchibao.vn');
  });
});

describe('xoá cookie', () => {
  it('khai LẠI ĐÚNG thuộc tính lúc đặt — lệch một cái là xoá không ăn', () => {
    process.env.AUTH_COOKIE_SAMESITE = 'none';
    process.env.AUTH_COOKIE_DOMAIN = '.vienchibao.vn';

    const a = fakeRes();
    setAuthCookies(a.res, tokens);
    const b = fakeRes();
    clearAuthCookies(b.res);

    for (const name of [ACCESS_COOKIE, REFRESH_COOKIE]) {
      const { expires: _e, ...setOpts } = a.setOf(name).options;
      expect(b.clearedOf(name).options).toEqual(setOpts);
    }
  });

  it('xoá cả hai cookie, không bỏ sót refresh token', () => {
    const { res, cleared } = fakeRes();
    clearAuthCookies(res);
    expect(cleared.map((c) => c.name).sort()).toEqual(
      [ACCESS_COOKIE, REFRESH_COOKIE].sort(),
    );
  });
});
