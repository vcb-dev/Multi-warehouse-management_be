import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionScope } from '@prisma/client';
import {
  hasLocationPermission,
  hasSystemPermission,
  resolveWarehouseId,
} from '../auth/access';
import { AuthUser } from '../decorators/current-user.decorator';
import { PUBLIC_KEY } from '../decorators/roles.decorator';
import {
  LOCATION_OPTIONAL_KEY,
  PERMISSION_KEY,
} from '../decorators/permissions.decorator';
import { BusinessException } from '../exceptions/business.exception';
import { PERMISSION_SCOPE } from '../../modules/rbac/permission-catalog';
import { ApiKeyService } from '../../modules/api-keys/api-key.service';
import { TokenService } from '../../modules/auth/token.service';
import { ACCESS_COOKIE } from '../auth/cookies';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

type AuthRequest = {
  headers: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string | undefined>;
  user?: AuthUser;
};

function readHeader(req: AuthRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function readAccessToken(req: AuthRequest): string | undefined {
  const fromCookie = req.cookies?.[ACCESS_COOKIE]?.trim();
  if (fromCookie) return fromCookie;
  const authorization = readHeader(req, 'authorization');
  return authorization?.replace(/^Bearer\s+/i, '').trim() || undefined;
}

/**
 * Cổng xác thực duy nhất của toàn hệ thống — chấp nhận BA cách, theo đúng thứ tự này:
 * - `x-api-key: <key>` (đối tác server-to-server, không đăng nhập).
 * - Cookie `vcb_access_token` (trình duyệt — đường chính của người dùng thật).
 * - `Authorization: Bearer <access token>` (Swagger, script, test — không có cookie jar).
 *
 * Cookie đứng TRƯỚC header vì đó là đường mà trình duyệt tự gửi; header chỉ là lối vào
 * cho những client không có cookie. Hai đường mang cùng một access token nên xử lý giống
 * hệt nhau — chỉ khác chỗ đọc ra chuỗi.
 *
 * Key đối tác xác thực THAY một user có sẵn (`ApiKey.actingUserId`) nên `req.user` dựng ra
 * có đúng shape/quyền như phiên người dùng — `PermissionGuard` phía sau không cần biết
 * request đến từ đường nào.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private apiKeys: ApiKeyService,
    private tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthRequest>();

    const rawKey = readHeader(req, 'x-api-key');
    if (rawKey) {
      const authUser = await this.apiKeys.resolveAuthUser(rawKey);
      if (!authUser) {
        throw new UnauthorizedException('API key không hợp lệ hoặc đã hết hạn');
      }
      req.user = authUser;
      return true;
    }

    const token = readAccessToken(req);
    if (!token) throw new UnauthorizedException();

    const authUser = await this.tokens.resolveAuthUser(token);
    // Cố ý không phân biệt "chữ ký sai" với "hết hạn" hay "phiên đã thu hồi": nói rõ là
    // xác nhận giúp kẻ tấn công rằng token họ nhặt được từng là thật.
    if (!authUser) throw new UnauthorizedException();

    req.user = authUser;
    return true;
  }
}

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required?.length) return true;

    const req = context.switchToHttp().getRequest<{
      user?: AuthUser;
      method?: string;
      params: Record<string, string>;
      query: Record<string, string>;
      body: Record<string, unknown>;
      headers: Record<string, string | string[] | undefined>;
    }>();
    const user = req.user;
    if (!user) throw new ForbiddenException('Unauthorized');

    const locationId = resolveWarehouseId({
      params: req.params,
      query: req.query,
      body: req.body,
      headers: req.headers,
    });

    const isWrite = WRITE_METHODS.has((req.method ?? 'GET').toUpperCase());
    const locationOptional =
      this.reflector.getAllAndOverride<boolean>(LOCATION_OPTIONAL_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;
    // Ghi mà không khai được kho thì không biết phải kiểm quyền tại kho nào —
    // "có quyền ở kho bất kỳ" chỉ chấp nhận được cho hành động đọc (spec §5).
    const missingLocation = isWrite && !locationId && !locationOptional;

    const ok = required.some((perm) => {
      const scope = PERMISSION_SCOPE[perm] ?? PermissionScope.system;
      if (scope === PermissionScope.system) {
        return hasSystemPermission(user, perm);
      }
      if (missingLocation) return false;
      return hasLocationPermission(user, perm, locationId);
    });

    if (ok) return true;

    // Phân biệt "thiếu kho" với "thiếu quyền" để client sửa được lỗi.
    const blockedByMissingLocation =
      missingLocation &&
      required.some(
        (perm) =>
          (PERMISSION_SCOPE[perm] ?? PermissionScope.system) ===
          PermissionScope.location,
      );
    if (blockedByMissingLocation) {
      throw new BusinessException(
        'LOCATION_REQUIRED',
        'Chưa xác định kho thao tác. Chọn kho làm việc rồi thử lại.',
        403,
      );
    }
    throw new ForbiddenException('FORBIDDEN');
  }
}
