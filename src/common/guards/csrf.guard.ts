import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../auth/cookies';
import { isAllowedOrigin } from '../http/cors-origins';

/** Chỉ lệnh ghi mới cần chặn — GET không đổi trạng thái thì có bị giả mạo cũng vô hại. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Header do mã của FE tự đặt. Site khác không đặt được nó bằng form hay thẻ `<img>`:
 * muốn kèm header tự chế thì trình duyệt bắt phải preflight trước, mà preflight sẽ trượt
 * `CORS_ORIGIN`. Giá trị là gì không quan trọng — quan trọng là nó CÓ mặt.
 */
const CSRF_HEADER = 'x-requested-with';

type CsrfRequest = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string | undefined>;
};

function header(req: CsrfRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}


@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<CsrfRequest>();
    if (!WRITE_METHODS.has((req.method ?? 'GET').toUpperCase())) return true;

    const carriesSessionCookie = Boolean(
      req.cookies?.[ACCESS_COOKIE] || req.cookies?.[REFRESH_COOKIE],
    );
    if (!carriesSessionCookie) return true;

    // Trình duyệt luôn gửi `Origin` cho lệnh ghi và không cho trang web sửa nó. Vắng mặt
    // là client không phải trình duyệt (curl, script) — chúng không bị CSRF, nên để phần
    // kiểm tra header phía dưới quyết định.
    const origin = header(req, 'origin');
    if (origin && !isAllowedOrigin(origin)) {
      throw new ForbiddenException('CSRF_ORIGIN_REJECTED');
    }

    if (!header(req, CSRF_HEADER)) {
      throw new ForbiddenException('CSRF_HEADER_REQUIRED');
    }
    return true;
  }
}
