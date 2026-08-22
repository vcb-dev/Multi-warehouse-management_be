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

  it('mặc định SameSite=Lax — đủ cho dev localhost:3002 -> :3001 (cùng site)', () => {
    const { res, setOf } = fakeRes();
    setAuthCookies(res, tokens);
    expect(setOf(ACCESS_COOKIE).options.sameSite).toBe('lax');
  });

  it('SameSite=None thì Secure BẬT theo, kể cả khi env bảo tắt', () => {
    // Trình duyệt vứt thẳng cookie `SameSite=None` không kèm `Secure`. Để lọt cấu hình
    // này là mất cả buổi truy vì phía server không báo lỗi gì.
    process.env.AUTH_COOKIE_SAMESITE = 'none';
    process.env.AUTH_COOKIE_SECURE = 'false';
    const { res, setOf } = fakeRes();
    setAuthCookies(res, tokens);
    expect(setOf(ACCESS_COOKIE).options.sameSite).toBe('none');
    expect(setOf(ACCESS_COOKIE).options.secure).toBe(true);
  });

  it('production mặc định Secure ngay cả khi không khai gì', () => {
    process.env.NODE_ENV = 'production';
    const { res, setOf } = fakeRes();
    setAuthCookies(res, tokens);
    expect(setOf(ACCESS_COOKIE).options.secure).toBe(true);
  });

  it('giá trị SameSite lạ rơi về `lax` chứ không lọt thẳng vào header', () => {
    process.env.AUTH_COOKIE_SAMESITE = 'yes-please';
    const { res, setOf } = fakeRes();
    setAuthCookies(res, tokens);
    expect(setOf(ACCESS_COOKIE).options.sameSite).toBe('lax');
  });

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
