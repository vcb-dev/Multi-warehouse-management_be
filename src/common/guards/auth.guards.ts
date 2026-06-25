import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { CanActivate, ForbiddenException } from '@nestjs/common';
import { PermissionScope } from '@prisma/client';
import {
  hasSystemPermission,
  hasWarehousePermission,
  isAdminUser,
} from '../auth/access';
import { AuthUser } from '../decorators/current-user.decorator';
import { PUBLIC_KEY } from '../decorators/roles.decorator';
import { PERMISSION_KEY } from '../decorators/permissions.decorator';
import { PERMISSION_SCOPE } from '../../modules/rbac/permission-catalog';

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
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const req = context.switchToHttp().getRequest<{
      user?: AuthUser;
      params: Record<string, string>;
      query: Record<string, string>;
      body: Record<string, unknown>;
    }>();
    const user = req.user;
    if (!user) throw new ForbiddenException('Unauthorized');
    if (isAdminUser(user)) return true;

    const warehouseId =
      req.params?.warehouseId ??
      req.query?.warehouse_id ??
      (req.body?.warehouse_id as string | undefined);

    const ok = required.some((perm) => {
      const scope = PERMISSION_SCOPE[perm] ?? PermissionScope.system;
      if (scope === PermissionScope.warehouse) {
        return hasWarehousePermission(user, perm, warehouseId);
      }
      return hasSystemPermission(user, perm);
    });

    if (!ok) throw new ForbiddenException('FORBIDDEN');
    return true;
  }
}

@Injectable()
export class BranchScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      user?: AuthUser;
      params: Record<string, string>;
      query: Record<string, string>;
      body: Record<string, unknown>;
    }>();
    const user = req.user;
    if (!user || isAdminUser(user)) return true;

    const warehouseId =
      req.params.warehouseId ??
      req.query.warehouse_id ??
      (req.body?.warehouse_id as string | undefined);

    if (!warehouseId) return true;

    const wid = BigInt(warehouseId);
    if (!user.warehouseIds.some((id) => id === wid)) {
      throw new ForbiddenException('FORBIDDEN_SCOPE');
    }
    return true;
  }
}
