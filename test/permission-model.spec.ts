/**
 * Đặc tả thực thi (executable spec) của mô hình phân quyền ĐÍCH, theo
 * specs/009-cau-hinh/research.md §5 và docs/00-tong-quan/vai-tro-phan-quyen.md §3.
 *
 * QUY ƯỚC `it.failing`: đánh dấu hành vi đích CHƯA được cài đặt. Test PASS trong
 * lúc code còn sai và chuyển sang FAIL đúng lúc phase tương ứng hoàn tất — khi
 * đó đổi `it.failing` → `it`. Nhờ vậy CI vẫn xanh giữa chừng mà không ai quên
 * bật lại. Kế hoạch: docs/03-tech/ke-hoach-sua-phan-quyen.md
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionScope } from '@prisma/client';
import {
  assertLocationPermission,
  hasPermission,
  locationScopeFilter,
  locationsWithPermission,
} from '../src/common/auth/access';
import type { AuthUser } from '../src/common/decorators/current-user.decorator';
import { LOCATION_OPTIONAL_KEY } from '../src/common/decorators/permissions.decorator';
import { BusinessException } from '../src/common/exceptions/business.exception';
import { PermissionGuard } from '../src/common/guards/auth.guards';
import { RbacService } from '../src/modules/rbac/rbac.service';
import type { PrismaService } from '../src/prisma/prisma.service';

// --- helpers cho RbacService -------------------------------------------------

function fakePrisma(rows: unknown[], overrides: unknown[] = []): PrismaService {
  return {
    userLocationRole: { findMany: jest.fn().mockResolvedValue(rows) },
    userPermissionOverride: {
      findMany: jest.fn().mockResolvedValue(overrides),
    },
  } as unknown as PrismaService;
}

const p = (key: string, scope: PermissionScope = PermissionScope.location) => ({
  permission: { key, scope },
});

const roleAt = (
  locationId: bigint,
  permissions: ReturnType<typeof p>[],
  role: { isSystem?: boolean; code?: string } = {},
) => ({
  locationId,
  role: {
    isSystem: role.isSystem ?? false,
    code: role.code ?? 'sales',
    permissions,
  },
});

const adminAt = (locationId: bigint) =>
  roleAt(
    locationId,
    [p('order:pack'), p('staff:manage', PermissionScope.system)],
    {
      isSystem: true,
      code: 'admin',
    },
  );

const resolve = (rows: unknown[]) =>
  new RbacService(fakePrisma(rows)).resolvePermissions(1n);

function authUserOf(
  resolved: Awaited<ReturnType<RbacService['resolvePermissions']>>,
): AuthUser {
  return {
    userId: 1n,
    email: 'u@test',
    roles: [],
    locationIds: resolved.locationIds,
    isAdmin: resolved.isAdmin,
    adminWarehouseIds: resolved.adminWarehouseIds,
    systemPermissions: resolved.systemPermissions,
    warehousePermissions: resolved.warehousePermissions,
  };
}

// --- helpers cho PermissionGuard --------------------------------------------

function ctx(
  user: AuthUser | undefined,
  req: Partial<Record<string, unknown>> = {},
) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        user,
        method: 'GET',
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

const guardWith = (required: string[], locationOptional = false) =>
  new PermissionGuard({
    getAllAndOverride: (key: string) =>
      key === LOCATION_OPTIONAL_KEY ? locationOptional : required,
  } as unknown as Reflector);

/** Có `order:pack` ở kho 1, ở kho 2 chỉ được xem. */
const packer: AuthUser = {
  userId: 1n,
  email: 'packer@test',
  roles: [],
  locationIds: [1n, 2n],
  warehousePermissions: { '1': ['order:pack'], '2': ['order:view'] },
};

// ----------------------------------------------------------------------------

describe('Mô hình phân quyền đích', () => {
  describe('Quy tắc 1 — role admin là toàn hệ thống (Phase 2)', () => {
    it('nhận diện được user mang role admin', async () => {
      expect((await resolve([adminAt(1n)])).isAdmin).toBe(true);
    });

    it('admin có quyền tại kho chưa được gán', async () => {
      const user = authUserOf(await resolve([adminAt(1n)]));
      expect(hasPermission(user, 'order:pack', '99')).toBe(true);
    });
  });

  describe('Quy tắc 2 — permission scope=system hiệu lực toàn cục (Phase 2)', () => {
    it('gom vào systemPermissions', async () => {
      const resolved = await resolve([
        roleAt(1n, [
          p('order:view'),
          p('customer:view', PermissionScope.system),
        ]),
      ]);
      expect(resolved.systemPermissions).toContain('customer:view');
    });

    it('không bị nhét vào bucket theo kho', async () => {
      const resolved = await resolve([
        roleAt(1n, [p('customer:view', PermissionScope.system)]),
      ]);
      expect(resolved.warehousePermissions['1'] ?? []).not.toContain(
        'customer:view',
      );
    });

    it('hiệu lực cả ở kho mà role tại đó không khai quyền này', async () => {
      const user = authUserOf(
        await resolve([
          roleAt(1n, [p('customer:view', PermissionScope.system)]),
          roleAt(2n, [p('order:view')]),
        ]),
      );
      expect(hasPermission(user, 'customer:view', '2')).toBe(true);
    });
  });

  describe('Quy tắc 3 — permission scope=location theo từng kho (đã đúng)', () => {
    it('chỉ hiệu lực tại kho được gán quyền đó', async () => {
      const user = authUserOf(
        await resolve([
          roleAt(1n, [p('order:pack')]),
          roleAt(2n, [p('order:view')]),
        ]),
      );
      expect(hasPermission(user, 'order:pack', '1')).toBe(true);
      expect(hasPermission(user, 'order:pack', '2')).toBe(false);
    });
  });

  describe('Quy tắc 4 — thiếu kho trong request: đọc cho qua, ghi từ chối (Phase 3)', () => {
    it('ĐỌC không kèm kho → cho qua, tầng service chịu trách nhiệm lọc', () => {
      expect(
        guardWith(['order:pack']).canActivate(ctx(packer, { method: 'GET' })),
      ).toBe(true);
    });

    it('GHI kèm kho không có quyền → từ chối', () => {
      expect(() =>
        guardWith(['order:pack']).canActivate(
          ctx(packer, { method: 'POST', query: { location_id: '2' } }),
        ),
      ).toThrow(ForbiddenException);
    });

    it('GHI không kèm kho → từ chối kèm mã LOCATION_REQUIRED', () => {
      expect(() =>
        guardWith(['order:pack']).canActivate(ctx(packer, { method: 'POST' })),
      ).toThrow(BusinessException);
      try {
        guardWith(['order:pack']).canActivate(ctx(packer, { method: 'POST' }));
      } catch (e) {
        expect((e as BusinessException).code).toBe('LOCATION_REQUIRED');
        expect((e as BusinessException).statusCode).toBe(403);
      }
    });

    it('ghi không khai kho bị chặn kể cả khi có quyền ở kho khác', () => {
      // POST /fulfillments/packing chỉ mang order_id (CreatePackingDto không có
      // location_id). Trước đây guard cho qua bằng luật "có quyền ở bất kỳ kho
      // nào" rồi tầng service chỉ kiểm tra tư cách thành viên kho.
      expect(() =>
        guardWith(['order:pack']).canActivate(
          ctx(packer, { method: 'POST', body: { order_id: '77' } }),
        ),
      ).toThrow(BusinessException);
    });

    // ⚠️ Guard KHÔNG đóng được kịch bản chéo kho thật sự: client tự khai kho, nên
    // kẻ tấn công khai kho 1 (nơi mình có order:pack) rồi thao tác đơn thuộc kho
    // 2 thì guard vẫn cho qua. Chỉ chặn được khi tầng service kiểm quyền tại kho
    // CỦA TÀI NGUYÊN — đó là Phase 4.
    it('guard cho qua khi khai kho có quyền, dù tài nguyên nằm ở kho khác', () => {
      expect(
        guardWith(['order:pack']).canActivate(
          ctx(packer, {
            method: 'POST',
            body: { order_id: '77' },
            headers: { 'x-warehouse-id': '1' },
          }),
        ),
      ).toBe(true);
    });

    it('@LocationOptional cho phép ghi không kèm kho (dữ liệu toàn cục)', () => {
      expect(
        guardWith(['order:pack'], true).canActivate(
          ctx(packer, { method: 'POST' }),
        ),
      ).toBe(true);
    });

    it('@LocationOptional vẫn đòi có quyền ở ít nhất một kho', () => {
      const noPack: AuthUser = { ...packer, warehousePermissions: {} };
      expect(() =>
        guardWith(['order:pack'], true).canActivate(
          ctx(noPack, { method: 'POST' }),
        ),
      ).toThrow(ForbiddenException);
    });

    it('quyền scope=system không bị ảnh hưởng bởi luật khai kho', () => {
      const staff: AuthUser = {
        ...packer,
        systemPermissions: ['staff:manage'],
      };
      expect(
        guardWith(['staff:manage']).canActivate(ctx(staff, { method: 'POST' })),
      ).toBe(true);
    });
  });

  describe('Quy tắc 5 — phạm vi dữ liệu theo kho CÓ QUYỀN (Phase 4)', () => {
    /** Thành viên cả hai kho, nhưng chỉ được xem đơn ở kho 1. */
    const viewer: AuthUser = {
      userId: 1n,
      email: 'v@test',
      roles: [],
      locationIds: [1n, 2n],
      warehousePermissions: { '1': ['order:view'], '2': ['order:pack'] },
    };

    it('lọc theo kho có quyền, không phải kho được gán', () => {
      expect(locationsWithPermission(viewer, 'order:view')).toEqual([1n]);
      expect(locationScopeFilter(viewer, 'order:view')).toEqual({ in: [1n] });
    });

    it('nhận danh sách quyền — có MỘT trong số đó là đủ', () => {
      expect(
        locationsWithPermission(viewer, ['order:view', 'order:pack']),
      ).toEqual([1n, 2n]);
    });

    it('admin không bị lọc: undefined = bỏ hẳn điều kiện', () => {
      const admin: AuthUser = { ...viewer, isAdmin: true };
      expect(locationsWithPermission(admin, 'order:view')).toBeUndefined();
      expect(locationScopeFilter(admin, 'order:view')).toBeUndefined();
    });

    it('không có quyền ở kho nào → mảng rỗng, tức không thấy gì', () => {
      expect(locationsWithPermission(viewer, 'purchasing:manage')).toEqual([]);
      expect(locationScopeFilter(viewer, 'purchasing:manage')).toEqual({
        in: [],
      });
    });

    it('assertLocationPermission chặn thao tác tại kho của TÀI NGUYÊN', () => {
      // Đây là thứ đóng lỗ hổng chéo kho: dù client khai kho nào, thao tác trên
      // đơn thuộc kho 2 vẫn phải có quyền tương ứng tại chính kho 2.
      expect(() => assertLocationPermission(viewer, 'order:view', 2n)).toThrow(
        BusinessException,
      );
      expect(() =>
        assertLocationPermission(viewer, 'order:view', 1n),
      ).not.toThrow();
    });

    it('assertLocationPermission cho admin đi qua ở mọi kho', () => {
      const admin: AuthUser = { ...viewer, isAdmin: true };
      expect(() =>
        assertLocationPermission(admin, 'order:view', 999n),
      ).not.toThrow();
    });
  });

  describe('Quy tắc 6 — product:manage giữ scope=location vì PriceList dùng chung (Phase 6)', () => {
    // PriceList (bảng giá) có location_id TUỲ CHỌN — bảng giá theo kho dùng
    // chung permission product:manage. Guard tự đọc `location_id` từ body
    // (CreatePriceListDto) nên cơ chế này hoạt động mà PriceListService không
    // cần biết gì về AuthUser — chỉ đứng vững nếu product:manage còn là
    // scope=location. Đây là quy tắc đã suýt bị gỡ nhầm ở Phase 6.
    const manager: AuthUser = {
      userId: 1n,
      email: 'm@test',
      roles: [],
      locationIds: [1n],
      warehousePermissions: { '1': ['product:manage'] },
    };

    it('tạo bảng giá cho kho mình quản lý thì được', () => {
      expect(
        guardWith(['product:manage']).canActivate(
          ctx(manager, {
            method: 'POST',
            body: { code: 'BG1', location_id: '1' },
          }),
        ),
      ).toBe(true);
    });

    it('tạo bảng giá cho kho KHÁC (mình không có product:manage) bị chặn', () => {
      expect(() =>
        guardWith(['product:manage']).canActivate(
          ctx(manager, {
            method: 'POST',
            body: { code: 'BG2', location_id: '2' },
          }),
        ),
      ).toThrow();
    });

    it('tạo bảng giá TOÀN CỤC (không location_id) vẫn được nhờ @LocationOptional', () => {
      expect(
        guardWith(['product:manage'], true).canActivate(
          ctx(manager, { method: 'POST', body: { code: 'BG3' } }),
        ),
      ).toBe(true);
    });
  });
});
