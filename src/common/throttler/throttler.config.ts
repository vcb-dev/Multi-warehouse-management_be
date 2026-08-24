import { ExecutionContext } from '@nestjs/common';
import type { ThrottlerOptions } from '@nestjs/throttler';

export type ThrottleRequest = {
  headers: Record<string, unknown>;
  url?: string;
  ip?: string;
  body?: { email?: unknown };
};

export function getThrottleRequest(context: ExecutionContext): ThrottleRequest {
  return context.switchToHttp().getRequest<ThrottleRequest>();
}

/**
 * `setGlobalPrefix('api')` nên đường dẫn thật có tiền tố `/api`. Sai chuỗi này là
 * bộ đếm im lặng không chạy — không lỗi, không log, chỉ là hết bảo vệ.
 */
export const LOGIN_PATH = '/api/auth/login';

/** Cùng lý do với `LOGIN_PATH`: sai chuỗi là bộ đếm im lặng không chạy. */
export const REFRESH_PATH = '/api/auth/refresh';

/**
 * Đối tác bên thứ 3: API key gọi được MỌI route nên chặn lạm dụng ở tầng toàn cục.
 * Bỏ qua traffic JWT nội bộ.
 */
export const apiKeyThrottler: ThrottlerOptions = {
  name: 'default',
  ttl: 60_000,
  limit: 120,
  skipIf: (context) => !getThrottleRequest(context).headers['x-api-key'],
};

/**
 * Dò mật khẩu. Đếm theo cặp IP + email chứ không riêng IP: nhiều nhân viên ngồi sau
 * cùng một IP văn phòng, chặn theo IP là một người gõ sai vài lần thì cả phòng không
 * đăng nhập được.
 */
export const loginThrottler: ThrottlerOptions = {
  name: 'auth',
  ttl: 60_000,
  limit: 5,
  skipIf: (context) => !getThrottleRequest(context).url?.startsWith(LOGIN_PATH),
  getTracker: (req: ThrottleRequest) => {
    const email = String(req.body?.email ?? '')
      .trim()
      .toLowerCase();
    const ip = req.ip ?? 'unknown';
    return email ? `${ip}|${email}` : ip;
  },
};

/**
 * Gia hạn. `@Public()` và có tra database, nên không đếm là để hở một đường ai cũng gọi
 * được không giới hạn.
 *
 * Đếm theo IP thôi — khác login, ở đây không có `email` trong body để tách người dùng ra.
 * Hạn mức rộng tay hơn nhiều so với login vì đây là hành vi hợp lệ, lặp lại đều đặn: mỗi
 * tab mở nhiều là một lượt gia hạn mỗi 15 phút, cả một văn phòng ngồi sau một IP NAT thì
 * cộng lại vẫn phải lọt. 60 lượt/phút đủ rộng cho việc đó mà vẫn chặn được vòng lặp hỏng
 * ở client tự quay cho tới khi sập backend.
 */
export const refreshThrottler: ThrottlerOptions = {
  name: 'refresh',
  ttl: 60_000,
  limit: 60,
  skipIf: (context) =>
    !getThrottleRequest(context).url?.startsWith(REFRESH_PATH),
  getTracker: (req: ThrottleRequest) => req.ip ?? 'unknown',
};

/**
 * Ba bộ đếm độc lập. `skipIf` và `getTracker` đọc theo TỪNG định nghĩa (xem
 * ThrottlerGuard: `namedThrottler.skipIf || commonOptions.skipIf`), nên mỗi bộ tự
 * chọn phạm vi của mình mà không cần guard riêng.
 */
export const throttlerDefinitions = [
  apiKeyThrottler,
  loginThrottler,
  refreshThrottler,
];
