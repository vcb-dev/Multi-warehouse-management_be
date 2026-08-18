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
 * Hai bộ đếm độc lập. `skipIf` và `getTracker` đọc theo TỪNG định nghĩa (xem
 * ThrottlerGuard: `namedThrottler.skipIf || commonOptions.skipIf`), nên mỗi bộ tự
 * chọn phạm vi của mình mà không cần guard riêng.
 */
export const throttlerDefinitions = [apiKeyThrottler, loginThrottler];
