/**
 * Unit test PermissionGuard — quyền theo kho đang làm việc.
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionGuard } from '../src/common/guards/auth.guards';
import type { AuthUser } from '../src/common/decorators/current-user.decorator';

function ctx(user: AuthUser | undefined, req: Partial<Record<string, unknown>> = {}) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        user,
        params: {},
        query: {},
        body: {},
        headers: {},
        ...req,
      }),
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
  warehousePermissions: {
    '1': ['order:view', 'order:pack', 'customer:view'],
    '2': ['order:view'],
  },
};

describe('PermissionGuard', () => {
  it('cho phép khi không khai báo permission', () => {
    const guard = guardWith([]);
    expect(guard.canActivate(ctx(baseUser))).toBe(true);
  });

  it('system-scope: kiểm tra theo kho trong header', () => {
    const guard = guardWith(['customer:view']);
    expect(
      guard.canActivate(
        ctx(baseUser, { headers: { 'x-warehouse-id': '1' } }),
      ),
    ).toBe(true);
    expect(() =>
      guard.canActivate(ctx(baseUser, { headers: { 'x-warehouse-id': '2' } })),
    ).toThrow(ForbiddenException);
  });

  it('warehouse-scope: không cấp qua kho khác', () => {
    const guard = guardWith(['order:pack']);
    expect(() =>
      guard.canActivate(ctx(baseUser, { query: { warehouse_id: '2' } })),
    ).toThrow(ForbiddenException);
  });

  it('system-scope: thiếu quyền -> Forbidden', () => {
    const guard = guardWith(['staff:manage']);
    expect(() =>
      guard.canActivate(ctx(baseUser, { headers: { 'x-warehouse-id': '1' } })),
    ).toThrow(ForbiddenException);
  });

  it('warehouse-scope: kiểm tra theo warehouse_id trong query', () => {
    const guard = guardWith(['order:pack']);
    expect(
      guard.canActivate(ctx(baseUser, { query: { warehouse_id: '1' } })),
    ).toBe(true);
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

  it('admin chỉ bypass tại kho được gán admin', () => {
    const admin: AuthUser = {
      ...baseUser,
      adminWarehouseIds: [1n],
      isAdmin: true,
    };
    const guard = guardWith(['staff:manage']);
    expect(
      guard.canActivate(ctx(admin, { query: { warehouse_id: '1' } })),
    ).toBe(true);
    expect(() =>
      guard.canActivate(ctx(admin, { query: { warehouse_id: '2' } })),
    ).toThrow(ForbiddenException);
  });

  it('role:manage không bypass nếu không phải admin tại kho', () => {
    const fakeAdmin: AuthUser = {
      ...baseUser,
      warehousePermissions: {
        '1': ['role:manage'],
        '2': ['order:view'],
      },
    };
    const guard = guardWith(['staff:manage']);
    expect(() =>
      guard.canActivate(
        ctx(fakeAdmin, { headers: { 'x-warehouse-id': '1' } }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('không có user -> Forbidden', () => {
    const guard = guardWith(['order:view']);
    expect(() => guard.canActivate(ctx(undefined))).toThrow(ForbiddenException);
  });
});
