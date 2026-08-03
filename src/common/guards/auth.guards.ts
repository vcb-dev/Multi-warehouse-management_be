import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { CanActivate, ForbiddenException } from '@nestjs/common';
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

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
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
