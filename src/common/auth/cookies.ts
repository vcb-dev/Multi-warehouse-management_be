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

/**
 * Danh sách trắng, không phải ép kiểu: `process.env` là `string` bất kỳ, còn Express chỉ
 * nhận đúng ba giá trị này và ném `TypeError` với mọi thứ khác. Gõ nhầm `nonee` mà thả
 * thẳng xuống thì app không chết lúc khởi động — nó chết lúc có người đăng nhập.
 *
 * Mặc định `lax`. Nó chặn đúng vector CSRF chính — POST/`fetch` từ site khác không được
 * mang cookie đi — và đó cũng là mặc định mà trình duyệt tự áp cho cookie không khai
 * `SameSite`, nên khai tường minh chỉ là nói rõ ra thứ vốn đã xảy ra.
 *
 * `strict` chặt hơn một chút: nó chặn thêm cả điều hướng GET từ site khác. Với app hiện
 * tại thì phần thêm đó gần như không có tác dụng thật (không có endpoint GET nào đổi
 * trạng thái), nhưng nó lại đóng mất một cánh cửa: link trong email trỏ THẲNG vào một
 * endpoint API và dựa vào cookie phiên sẽ không hoạt động dưới `strict`. Chọn `lax` để
 * luồng gửi mail sau này không bị chặn bởi một quyết định đặt từ hôm nay.
 *
 * (Nếu làm link tải file qua email, mẫu bền hơn vẫn là token ký một lần trong URL —
 * không phụ thuộc cookie, nên link bị forward hay bị proxy quét cũng không lộ dữ liệu của
 * người khác. Lúc đó `SameSite` không còn liên quan.)
 *
 * Điều KHÔNG bao giờ được rơi vào là `none`: quên khai biến này mà rơi xuống đó là mất
 * sạch chống CSRF trong im lặng — không hỏng gì, không ai biết. `lax` và `strict` thì cùng
 * lắm là hỏng ầm ĩ, mà hỏng ầm ĩ thì sửa được.
 *
 * Dù chọn cái nào, `CsrfGuard` vẫn gác mọi lệnh ghi — `SameSite` chỉ là lớp thứ hai.
 */
function readSameSite(): SameSite {
  const raw = process.env.AUTH_COOKIE_SAMESITE?.trim().toLowerCase();
  if (raw === 'none' || raw === 'strict' || raw === 'lax') return raw;
  return 'lax';
}

/**
 * `SameSite=None` bắt buộc đi kèm `Secure`: trình duyệt vứt thẳng cookie khai `None` mà
 * thiếu `Secure`. Đó là luật của trình duyệt chứ không phải lựa chọn ở đây — nên cấu hình
 * mâu thuẫn bị NÉM LỖI, không bị âm thầm sửa lưng. Nuốt giá trị người vận hành khai thì
 * thứ họ đọc trong `.env` và thứ đang thực chạy lệch nhau, mà lệch kiểu đó chỉ lộ ra sau
 * khi đã đi dò bug ở chỗ khác.
 *
 * Dev: FE `localhost:4002` và BE `localhost:4001` khác origin nhưng CÙNG site (cổng không
 * tính vào "site"), nên mặc định vẫn gửi cookie đi bình thường. Chỉ khi deploy hai bên lên
 * hai tên miền gốc khác nhau mới cần `AUTH_COOKIE_SAMESITE=none`.
 *
 * Biết trước một chuyện trước khi tới bước đó: Safari chặn cookie bên thứ ba theo tên miền
 * đăng ký được (eTLD+1), nên khai đúng `SameSite=None; Secure` vẫn không chạy trên
 * Safari/iOS — hai lớp khác nhau, lớp kia đứng trên. Lối ra duy nhất là đưa FE và BE về
 * cùng một tên miền gốc rồi bỏ biến này về `lax`.
 */
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
