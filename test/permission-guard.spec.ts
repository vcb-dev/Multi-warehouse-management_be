/**
 * Unit test PermissionGuard — system/warehouse scope, admin bypass.
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionGuard } from '../src/common/guards/auth.guards';
import type { AuthUser } from '../src/common/decorators/current-user.decorator';

function ctx(user: AuthUser | undefined, req: Partial<Record<string, unknown>> = {}) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user, params: {}, query: {}, body: {}, ...req }),
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function guardWith(required: string[]) {
  const reflector = {
    getAllAndOverride: () => required,
  } as unknown as Reflector;
  return new PermissionGuard(reflector);
}

const baseUser: AuthUser = {
  userId: 1n,
  email: 't@t',
  roles: [],
  warehouseIds: [1n, 2n],
  systemPermissions: ['customer:view'],
  permissions: ['customer:view'],
  warehousePermissions: { '1': ['order:view', 'order:pack'], '2': ['order:view'] },
};

describe('PermissionGuard', () => {
  it('cho phép khi không khai báo permission', () => {
    const guard = guardWith([]);
    expect(guard.canActivate(ctx(baseUser))).toBe(true);
  });

  it('system-scope: kiểm tra systemPermissions', () => {
    const guard = guardWith(['customer:view']);
    expect(guard.canActivate(ctx(baseUser))).toBe(true);
  });

  it('warehouse-scope: không cấp qua systemPermissions', () => {
    const systemOnly: AuthUser = {
      ...baseUser,
      systemPermissions: ['customer:view'],
      permissions: ['customer:view'],
      warehousePermissions: {},
    };
    const guard = guardWith(['order:view']);
    expect(() => guard.canActivate(ctx(systemOnly))).toThrow(ForbiddenException);
  });

  it('system-scope: thiếu quyền -> Forbidden', () => {
    const guard = guardWith(['staff:manage']);
    expect(() => guard.canActivate(ctx(baseUser))).toThrow(ForbiddenException);
  });

  it('warehouse-scope: kiểm tra theo warehouse_id trong query', () => {
    const guard = guardWith(['order:pack']);
    expect(
      guard.canActivate(ctx(baseUser, { query: { warehouse_id: '1' } })),
    ).toBe(true);
    expect(() =>
      guard.canActivate(ctx(baseUser, { query: { warehouse_id: '2' } })),
    ).toThrow(ForbiddenException);
  });

  it('warehouse-scope: thiếu warehouse_id -> kiểm tra bất kỳ kho nào', () => {
    const guard = guardWith(['order:pack']);
    expect(guard.canActivate(ctx(baseUser))).toBe(true);
    const noPack: AuthUser = {
      ...baseUser,
      warehousePermissions: { '2': ['order:view'] },
    };
    expect(() => guard.canActivate(ctx(noPack))).toThrow(ForbiddenException);
  });

  it('admin bypass mọi permission qua isAdmin', () => {
    const admin: AuthUser = { ...baseUser, isAdmin: true };
    const guard = guardWith(['staff:manage']);
    expect(guard.canActivate(ctx(admin))).toBe(true);
  });

  it('role:manage không còn bypass nếu không phải admin', () => {
    const fakeAdmin: AuthUser = {
      ...baseUser,
      systemPermissions: ['role:manage'],
      permissions: ['role:manage'],
    };
    const guard = guardWith(['staff:manage']);
    expect(() => guard.canActivate(ctx(fakeAdmin))).toThrow(ForbiddenException);
  });

  it('không có user -> Forbidden', () => {
    const guard = guardWith(['order:view']);
    expect(() => guard.canActivate(ctx(undefined))).toThrow(ForbiddenException);
  });
});
