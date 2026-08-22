import type { CookieOptions, Response } from 'express';

/**
 * Cookie đặt bởi CHÍNH backend, không phải Next.js: trình duyệt gọi thẳng API nên
 * không còn lớp proxy nào cầm token hộ. Tiền tố `vcb_` để không đụng cookie của app
 * khác cùng chạy trên `localhost` lúc dev.
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

/**
 * `SameSite=None` bắt buộc đi kèm `Secure` (trình duyệt vứt cookie nếu thiếu) — ép ở đây
 * để không phải phát hiện qua triệu chứng "đăng nhập xong vẫn 401" trên môi trường thật.
 *
 * Dev: FE `localhost:3002` và BE `localhost:3001` khác origin nhưng CÙNG site (cổng không
 * tính vào "site"), nên `Lax` mặc định vẫn gửi cookie đi bình thường. Chỉ khi deploy hai
 * bên lên hai domain khác nhau mới cần đặt `AUTH_COOKIE_SAMESITE=none`.
 */
function readSecure(sameSite: SameSite): boolean {
  const raw = process.env.AUTH_COOKIE_SECURE?.trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false' && sameSite !== 'none') return false;
  return sameSite === 'none' || process.env.NODE_ENV === 'production';
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
