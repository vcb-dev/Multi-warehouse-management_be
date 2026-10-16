import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import {
  canViewCost,
  COST_KEYS,
  redactKeys,
  stripKeys,
} from '../auth/sensitive-fields';
import { AuthUser } from '../decorators/current-user.decorator';

/**
 * Che giá vốn với người không có quyền `product:view_cost` (Sapo: `read_cost_price`).
 *
 * Gắn ở cấp controller cho các module có trả giá vốn. Hai chiều:
 * - response: mọi trường giá vốn về `null`;
 * - request ghi: bỏ trường giá vốn khỏi body TRƯỚC khi validate, để người không
 *   thấy giá vốn không vô tình ghi đè nó (form nhận `null` rồi gửi lại 0).
 *
 * Endpoint xuất file ghi thẳng vào `res` nên không đi qua `map` ở đây — chúng tự
 * lọc cột bằng `withoutCostColumns`.
 */
@Injectable()
export class CostVisibilityInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{
      method?: string;
      user?: AuthUser;
      body?: unknown;
    }>();
    // Chưa đăng nhập thì guard đã chặn; route @Public không có gì để che.
    if (!req.user || canViewCost(req.user)) return next.handle();

    const method = (req.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') stripKeys(req.body, COST_KEYS);
    return next.handle().pipe(map((body) => redactKeys(body, COST_KEYS)));
  }
}
