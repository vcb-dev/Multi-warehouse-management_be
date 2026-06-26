import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { CanActivate, ForbiddenException } from '@nestjs/common';
import { PermissionScope } from '@prisma/client';
import {
  hasPermission,
  isAdminAtWarehouse,
  resolveWarehouseId,
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
      headers: Record<string, string | string[] | undefined>;
    }>();
    const user = req.user;
    if (!user) throw new ForbiddenException('Unauthorized');

    const warehouseId = resolveWarehouseId({
      params: req.params,
      query: req.query,
      body: req.body,
      headers: req.headers,
    });

    const ok = required.some((perm) => {
      const scope = PERMISSION_SCOPE[perm] ?? PermissionScope.system;
      if (scope === PermissionScope.warehouse) {
        return hasPermission(user, perm, warehouseId);
      }
      return hasPermission(user, perm, warehouseId);
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
      headers: Record<string, string | string[] | undefined>;
    }>();
    const user = req.user;
    if (!user) return true;

    const warehouseId = resolveWarehouseId({
      params: req.params,
      query: req.query,
      body: req.body,
      headers: req.headers,
    });

    if (!warehouseId) return true;

    const wid = BigInt(warehouseId);
    if (isAdminAtWarehouse(user, warehouseId)) return true;
    if (!user.warehouseIds.some((id) => id === wid)) {
      throw new ForbiddenException('FORBIDDEN_SCOPE');
    }
    return true;
  }
}
