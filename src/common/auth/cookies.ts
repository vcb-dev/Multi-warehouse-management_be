import type { CookieOptions, Response } from 'express';
import { allowedOrigins } from '../http/cors-origins';

export const ACCESS_COOKIE = 'vcb_access_token';
export const REFRESH_COOKIE = 'vcb_refresh_token';


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
  return sameSite === 'none' || browserOnHttps();
}

function browserOnHttps(): boolean {
  return allowedOrigins().every((o) => o.startsWith('https://'));
}


export function assertAuthCookieConfig(): void {
  const origins = allowedOrigins();
  assertUniformScheme(origins);
  assertDomainReachable(origins);
  readSecure(readSameSite());
}

function assertUniformScheme(origins: string[]): void {
  const https = origins.filter((o) => o.startsWith('https://'));
  if (https.length === 0 || https.length === origins.length) return;
  throw new Error(
    'CORS_ORIGIN trộn http lẫn https — cờ Secure của cookie phiên không thể vừa đúng ' +
      `cho cả hai (${origins.join(', ')}). Tách môi trường ra, hoặc khai tay ` +
      'AUTH_COOKIE_SECURE nếu thực sự cố ý.',
  );
}

function assertDomainReachable(origins: string[]): void {
  const raw = process.env.AUTH_COOKIE_DOMAIN?.trim();
  if (!raw) return;

  const domain = raw.replace(/^\./, '').toLowerCase();
  const hosts = origins.map((o) => new URL(o).hostname.toLowerCase());
  const reachable = hosts.some((h) => h === domain || h.endsWith(`.${domain}`));
  if (reachable) return;

  throw new Error(
    `AUTH_COOKIE_DOMAIN="${raw}" không dùng được: không origin nào trong CORS_ORIGIN ` +
      `nằm dưới domain đó (${hosts.join(', ')}). Trình duyệt sẽ vứt cookie phiên ngay ` +
      'lúc nhận. FE và BE khác tên miền gốc (Vercel/Railway) thì phải BỎ TRỐNG biến này ' +
      '— cookie là host-only của domain FE.',
  );
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

export function clearAuthCookies(res: Response): void {
  const base = baseOptions();
  res.clearCookie(ACCESS_COOKIE, { ...base, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...base, path: REFRESH_COOKIE_PATH });
}
