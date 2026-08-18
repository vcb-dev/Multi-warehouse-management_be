/**
 * UserAdminService — chặn thao tác khiến hệ thống còn 0 admin (mất
 * `staff:manage` toàn cục thì không ai tự cứu lại được, phải sửa DB trực
 * tiếp). Xem docs/03-tech/ke-hoach-sua-phan-quyen.md — Phase 5.
 *
 * Fake Prisma phân biệt 3 dạng đếm bằng hình dạng `where`, không mô phỏng DB
 * đầy đủ — cùng phong cách với rbac-resolver.spec.ts / permission-guard.spec.ts.
 */
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { UserAdminService } from '../src/modules/rbac/user-admin.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { AuthUser } from '../src/common/decorators/current-user.decorator';
import type { AuthCacheService } from '../src/modules/rbac/auth-cache.service';

function fakeAuthCache(): AuthCacheService {
  return { invalidateUser: jest.fn() } as unknown as AuthCacheService;
}

type Where = Record<string, unknown>;

function fakePrisma(opts: {
  targetIsAdmin: boolean;
  otherActiveAdminExists: boolean;
  adminAtOtherLocation?: boolean;
}): PrismaService {
  const userLocationRoleCount = jest.fn((args: { where: Where }) => {
    const { where } = args;
    if (
      where.userId &&
      typeof where.userId === 'object' &&
      'not' in (where.userId as object)
    ) {
      // hasOtherActiveAdmin
      return Promise.resolve(opts.otherActiveAdminExists ? 1 : 0);
    }
    if (
      where.locationId &&
      typeof where.locationId === 'object' &&
      'not' in (where.locationId as object)
    ) {
      // removeWarehouseRole: còn admin ở kho khác không
      return Promise.resolve(opts.adminAtOtherLocation ? 1 : 0);
    }
    // isCurrentlyAdmin
    return Promise.resolve(opts.targetIsAdmin ? 1 : 0);
  });

  return {
    user: {
      // Trả đủ field cho cả lần tra existence (setStatus/putWarehouseRoles)
      // lẫn lần findOne() cuối (đọc kèm locationRoles) dùng chung một mock.
      findUnique: jest.fn().mockResolvedValue({
        id: 1n,
        active: true,
        status: 'active',
        passwordHash: 'x',
        locationRoles: [],
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    userLocationRole: {
      count: userLocationRoleCount,
      findUnique: jest.fn().mockResolvedValue({
        role: { code: 'admin', isSystem: true },
      }),
      deleteMany: jest.fn().mockResolvedValue({}),
      createMany: jest.fn().mockResolvedValue({}),
    },
    role: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 9n, code: 'admin', isSystem: true }]),
    },
    $transaction: jest.fn((fn: (tx: unknown) => unknown) =>
      fn({
        userLocationRole: {
          deleteMany: jest.fn().mockResolvedValue({}),
          createMany: jest.fn().mockResolvedValue({}),
        },
      }),
    ),
  } as unknown as PrismaService;
}

const adminCaller: AuthUser = {
  userId: 99n,
  email: 'admin@test',
  roles: [],
  locationIds: [],
  isAdmin: true,
};

const nonAdminCaller: AuthUser = {
  userId: 2n,
  email: 'staff@test',
  roles: [],
  locationIds: [],
  isAdmin: false,
};

describe('UserAdminService — bảo vệ admin cuối cùng', () => {
  describe('setStatus(false) — vô hiệu hoá tài khoản', () => {
    it('chặn nếu target là admin cuối cùng', async () => {
      const svc = new UserAdminService(
        fakePrisma({ targetIsAdmin: true, otherActiveAdminExists: false }),
        fakeAuthCache(),
      );
      await expect(svc.setStatus('1', false)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('cho qua nếu còn admin active khác', async () => {
      const svc = new UserAdminService(
        fakePrisma({ targetIsAdmin: true, otherActiveAdminExists: true }),
        fakeAuthCache(),
      );
      await expect(svc.setStatus('1', false)).resolves.toBeDefined();
    });

    it('cho qua nếu target vốn không phải admin', async () => {
      const svc = new UserAdminService(
        fakePrisma({ targetIsAdmin: false, otherActiveAdminExists: false }),
        fakeAuthCache(),
      );
      await expect(svc.setStatus('1', false)).resolves.toBeDefined();
    });

    it('không kiểm last-admin khi kích hoạt lại, nhưng vẫn invalidate cache', async () => {
      const prisma = fakePrisma({
        targetIsAdmin: true,
        otherActiveAdminExists: false,
      });
      const authCache = fakeAuthCache();
      const svc = new UserAdminService(prisma, authCache);
      await expect(svc.setStatus('1', true)).resolves.toBeDefined();
      expect(prisma.userLocationRole.count).not.toHaveBeenCalled();
      // Mở lại tài khoản cũng đổi quyền hiệu lực — không invalidate thì cache
      // 30s cũ vẫn coi user là inactive.
      expect(authCache.invalidateUser).toHaveBeenCalledWith(1n);
    });

    it('setStatus(false) hợp lệ vẫn invalidate cache ngay — không đợi hết TTL', async () => {
      const prisma = fakePrisma({
        targetIsAdmin: false,
        otherActiveAdminExists: false,
      });
      const authCache = fakeAuthCache();
      const svc = new UserAdminService(prisma, authCache);
      await svc.setStatus('1', false);
      expect(authCache.invalidateUser).toHaveBeenCalledWith(1n);
    });
  });

  describe('putWarehouseRoles — gán lại toàn bộ role theo kho', () => {
    const dtoKeepsAdmin = { assignments: [{ location_id: '1', role_id: '9' }] };
    const dtoDropsAdmin = { assignments: [{ location_id: '1', role_id: '7' }] };

    it('chặn nếu gỡ admin khỏi admin cuối cùng', async () => {
      const prisma = fakePrisma({
        targetIsAdmin: true,
        otherActiveAdminExists: false,
      });
      prisma.role.findMany = jest
        .fn()
        .mockResolvedValue([{ id: 7n, code: 'sales', isSystem: false }]);
      const svc = new UserAdminService(prisma, fakeAuthCache());
      await expect(
        svc.putWarehouseRoles('1', dtoDropsAdmin, adminCaller),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('cho qua nếu giữ nguyên admin, và invalidate cache của đúng user', async () => {
      const authCache = fakeAuthCache();
      const svc = new UserAdminService(
        fakePrisma({ targetIsAdmin: true, otherActiveAdminExists: false }),
        authCache,
      );
      await expect(
        svc.putWarehouseRoles('1', dtoKeepsAdmin, adminCaller),
      ).resolves.toBeDefined();
      expect(authCache.invalidateUser).toHaveBeenCalledWith(1n);
    });

    it('non-admin không gán được role admin cho người khác', async () => {
      const svc = new UserAdminService(
        fakePrisma({ targetIsAdmin: false, otherActiveAdminExists: true }),
        fakeAuthCache(),
      );
      await expect(
        svc.putWarehouseRoles('1', dtoKeepsAdmin, nonAdminCaller),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin gán role admin cho người khác thì được', async () => {
      const svc = new UserAdminService(
        fakePrisma({ targetIsAdmin: false, otherActiveAdminExists: true }),
        fakeAuthCache(),
      );
      await expect(
        svc.putWarehouseRoles('1', dtoKeepsAdmin, adminCaller),
      ).resolves.toBeDefined();
    });

    it('role_id không tồn tại -> ROLE_NOT_FOUND', async () => {
      const prisma = fakePrisma({
        targetIsAdmin: false,
        otherActiveAdminExists: true,
      });
      prisma.role.findMany = jest.fn().mockResolvedValue([]);
      const svc = new UserAdminService(prisma, fakeAuthCache());
      await expect(
        svc.putWarehouseRoles('1', dtoKeepsAdmin, adminCaller),
      ).rejects.toThrow('ROLE_NOT_FOUND');
    });
  });

  describe('removeWarehouseRole — gỡ role tại một kho', () => {
    it('chặn nếu đây là chỗ admin cuối cùng còn giữ', async () => {
      const svc = new UserAdminService(
        fakePrisma({
          targetIsAdmin: true,
          otherActiveAdminExists: false,
          adminAtOtherLocation: false,
        }),
        fakeAuthCache(),
      );
      await expect(svc.removeWarehouseRole('1', '1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('cho qua nếu user còn admin ở kho khác, và invalidate cache', async () => {
      const authCache = fakeAuthCache();
      const svc = new UserAdminService(
        fakePrisma({
          targetIsAdmin: true,
          otherActiveAdminExists: false,
          adminAtOtherLocation: true,
        }),
        authCache,
      );
      await expect(svc.removeWarehouseRole('1', '1')).resolves.toBeUndefined();
      expect(authCache.invalidateUser).toHaveBeenCalledWith(1n);
    });

    it('cho qua nếu role bị gỡ không phải admin', async () => {
      const prisma = fakePrisma({
        targetIsAdmin: false,
        otherActiveAdminExists: false,
      });
      prisma.userLocationRole.findUnique = jest
        .fn()
        .mockResolvedValue({ role: { code: 'sales', isSystem: false } });
      const svc = new UserAdminService(prisma, fakeAuthCache());
      await expect(svc.removeWarehouseRole('1', '1')).resolves.toBeUndefined();
      expect(prisma.userLocationRole.count).not.toHaveBeenCalled();
    });
  });
});
