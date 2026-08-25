import type { CookieOptions, Response } from 'express';

/**
 * Cookie đặt bởi CHÍNH backend, không phải Next.js: FE chỉ proxy request qua chứ không
 * cầm token hộ. Tiền tố `vcb_` để không đụng cookie của app khác cùng chạy trên
 * `localhost` lúc dev.
 *
 * KHÔNG bao giờ khai `AUTH_COOKIE_DOMAIN` trong mô hình proxy: cookie phải là host-only
 * của domain FE (Vercel). Khai domain của Railway vào đó là trình duyệt vứt cookie ngay
 * lúc nhận, vì nó không khớp domain đang mở.
 */
export const ACCESS_COOKIE = 'vcb_access_token';
export const REFRESH_COOKIE = 'vcb_refresh_token';

/**
 * `setGlobalPrefix('api')` nên toàn bộ route auth nằm dưới đường này. Refresh token chỉ
 * được gửi kèm cho đúng nhóm route này — mọi request nghiệp vụ khác không mang nó theo,
 * nên bề mặt rò rỉ hẹp hơn hẳn access token.
 */
const REFRESH_COOKIE_PATH = '/api/auth';

type SameSite = 'lax' | 'strict' | 'none';

function readSameSite(): SameSite {
  const raw = process.env.AUTH_COOKIE_SAMESITE?.trim().toLowerCase();
  if (raw === 'none' || raw === 'strict' || raw === 'lax') return raw;
  return 'lax';
}

function readSecure(sameSite: SameSite): boolean {
  const raw = process.env.AUTH_COOKIE_SECURE?.trim().toLowerCase();
  if (raw === 'false' && sameSite === 'none') {
    throw new Error(
      'Cấu hình mâu thuẫn: AUTH_COOKIE_SECURE=false không dùng được với ' +
        'AUTH_COOKIE_SAMESITE=none — trình duyệt vứt cookie khai None mà thiếu Secure. ' +
        'Bỏ trống AUTH_COOKIE_SECURE (nó tự bật) hoặc đổi SameSite về lax.',
    );
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  // Hai lý do độc lập để bật `Secure`, và cả hai đều cần:
  //
  // 1. `SameSite=none` — đây là luật của trình duyệt, không phải lựa chọn: cookie khai
  //    `None` mà thiếu `Secure` bị vứt thẳng.
  // 2. Production — từ khi FE proxy `/api` sang đây (xem `next.config.ts` bên FE), trình
  //    duyệt thấy cookie là first-party nên `SameSite` về lại `lax`, và vế (1) không bao
  //    giờ bật nữa. Thiếu vế này, cookie phiên trên Railway mất cờ `Secure` mà KHÔNG có
  //    lỗi nào báo — vẫn đăng nhập bình thường, chỉ là token chịu đi qua http.
  return sameSite === 'none' || process.env.NODE_ENV === 'production';
}

/**
 * Gọi lúc khởi động (`main.ts`) để cấu hình mâu thuẫn chết ngay tại đó thay vì chết ở lượt
 * đăng nhập đầu tiên — cùng lý do `allowedOrigins()` và `jwtSecret()` được gọi sớm.
 */
export function assertAuthCookieConfig(): void {
  readSecure(readSameSite());
}

function baseOptions(): CookieOptions {
  const sameSite = readSameSite();
  return {
    httpOnly: true,
    sameSite,
    secure: readSecure(sameSite),
    // Không đặt mặc định: sai domain là cookie im lặng không được gửi đi.
    ...(process.env.AUTH_COOKIE_DOMAIN
      ? { domain: process.env.AUTH_COOKIE_DOMAIN }
      : {}),
  };
}

export function setAuthCookies(
  res: Response,
  tokens: {
    accessToken: string;
    accessExpiresAt: Date;
    refreshToken: string;
    refreshExpiresAt: Date;
  },
): void {
  const base = baseOptions();
  res.cookie(ACCESS_COOKIE, tokens.accessToken, {
    ...base,
    path: '/',
    expires: tokens.accessExpiresAt,
  });
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...base,
    path: REFRESH_COOKIE_PATH,
    expires: tokens.refreshExpiresAt,
  });
}

/**
 * Xoá phải khai LẠI ĐÚNG path/domain/sameSite/secure lúc đặt. Lệch một thuộc tính là
 * trình duyệt coi đó là cookie khác và giữ nguyên cookie cũ — người dùng bấm đăng xuất
 * mà vẫn còn phiên.
 */
export function clearAuthCookies(res: Response): void {
  const base = baseOptions();
  res.clearCookie(ACCESS_COOKIE, { ...base, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...base, path: REFRESH_COOKIE_PATH });
}
