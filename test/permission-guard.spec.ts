/**
 * Unit test PermissionGuard — quyền theo kho đang làm việc.
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionGuard } from '../src/common/guards/auth.guards';
import type { AuthUser } from '../src/common/decorators/current-user.decorator';
import { LOCATION_OPTIONAL_KEY } from '../src/common/decorators/permissions.decorator';

function ctx(
  user: AuthUser | undefined,
  req: Partial<Record<string, unknown>> = {},
) {
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

function guardWith(required: string[], locationOptional = false) {
  const reflector = {
    getAllAndOverride: (key: string) =>
      key === LOCATION_OPTIONAL_KEY ? locationOptional : required,
  } as unknown as Reflector;
  return new PermissionGuard(reflector);
}

// `customer:view` khai scope=system nên resolvePermissions xếp nó vào
// systemPermissions (toàn cục), không nằm trong bucket theo kho.
const baseUser: AuthUser = {
  userId: 1n,
  email: 't@t',
  roles: [],
  locationIds: [1n, 2n],
  systemPermissions: ['customer:view'],
  warehousePermissions: {
    '1': ['order:view', 'order:pack'],
    '2': ['order:view'],
  },
};

describe('PermissionGuard', () => {
  it('cho phép khi không khai báo permission', () => {
    const guard = guardWith([]);
    expect(guard.canActivate(ctx(baseUser))).toBe(true);
  });

  it('quyền có tại kho trong header -> cho qua', () => {
    const guard = guardWith(['customer:view']);
    expect(
      guard.canActivate(ctx(baseUser, { headers: { 'x-warehouse-id': '1' } })),
    ).toBe(true);
  });

  // Quyền scope=system hiệu lực toàn cục, không phụ thuộc kho trong header.
  // Xem permission-model.spec.ts §2.
  it('perm scope=system hiệu lực cả ở kho khác', () => {
    const guard = guardWith(['customer:view']);
    expect(
      guard.canActivate(ctx(baseUser, { headers: { 'x-warehouse-id': '2' } })),
    ).toBe(true);
  });

  it('warehouse-scope: không cấp qua kho khác', () => {
    const guard = guardWith(['order:pack']);
    expect(() =>
      guard.canActivate(ctx(baseUser, { query: { location_id: '2' } })),
    ).toThrow(ForbiddenException);
  });

  it('system-scope: thiếu quyền -> Forbidden', () => {
    const guard = guardWith(['staff:manage']);
    expect(() =>
      guard.canActivate(ctx(baseUser, { headers: { 'x-warehouse-id': '1' } })),
    ).toThrow(ForbiddenException);
  });

  it('warehouse-scope: kiểm tra theo location_id trong query', () => {
    const guard = guardWith(['order:pack']);
    expect(
      guard.canActivate(ctx(baseUser, { query: { location_id: '1' } })),
    ).toBe(true);
  });

  // Chỉ đúng cho hành động ĐỌC. Hành động ghi mà thiếu kho phải bị từ chối —
  // xem permission-model.spec.ts §4 (theo specs/009-cau-hinh/research.md §5).
  it('đọc mà thiếu location_id -> kiểm tra bất kỳ kho nào', () => {
    const guard = guardWith(['order:pack']);
    expect(guard.canActivate(ctx(baseUser))).toBe(true);
    const noPack: AuthUser = {
      ...baseUser,
      warehousePermissions: { '2': ['order:view'] },
    };
    expect(() => guard.canActivate(ctx(noPack))).toThrow(ForbiddenException);
  });

  const admin: AuthUser = {
    ...baseUser,
    adminWarehouseIds: [1n],
    isAdmin: true,
  };

  it('admin bypass tại kho được gán admin', () => {
    const guard = guardWith(['staff:manage']);
    expect(guard.canActivate(ctx(admin, { query: { location_id: '1' } }))).toBe(
      true,
    );
  });

  // Role admin là toàn hệ thống, không giới hạn theo kho.
  // Xem docs/00-tong-quan/vai-tro-phan-quyen.md §1 — ADMIN phạm vi "toàn bộ".
  it('admin bypass ở mọi kho', () => {
    const guard = guardWith(['staff:manage']);
    expect(guard.canActivate(ctx(admin, { query: { location_id: '2' } }))).toBe(
      true,
    );
  });

  it('role:manage không bypass nếu không phải admin tại kho', () => {
    const fakeAdmin: AuthUser = {
      ...baseUser,
      systemPermissions: ['role:manage'],
      warehousePermissions: { '2': ['order:view'] },
    };
    const guard = guardWith(['staff:manage']);
    expect(() =>
      guard.canActivate(ctx(fakeAdmin, { headers: { 'x-warehouse-id': '1' } })),
    ).toThrow(ForbiddenException);
  });

  it('không có user -> Forbidden', () => {
    const guard = guardWith(['order:view']);
    expect(() => guard.canActivate(ctx(undefined))).toThrow(ForbiddenException);
  });
});
