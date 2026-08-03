/**
 * Unit test RoleService — quyền nhạy cảm chỉ dành cho role hệ thống.
 */
import { ForbiddenException } from '@nestjs/common';
import { RoleService } from '../src/modules/rbac/role.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { AuthCacheService } from '../src/modules/rbac/auth-cache.service';

// Không test nào ở đây chạm nhánh invalidate cache (tạo role mới, hoặc sửa
// role hệ thống bị chặn sớm) — fake rỗng chỉ để thoả kiểu.
const fakeAuthCache = {} as AuthCacheService;

function serviceWithNoExistingRole() {
  const prisma = {
    role: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    },
    permission: { findMany: jest.fn() },
  } as unknown as PrismaService;
  return { svc: new RoleService(prisma, fakeAuthCache), prisma };
}

describe('RoleService protected permissions', () => {
  it('PROTECTED_PERMISSION khi gán role:manage', async () => {
    const { svc } = serviceWithNoExistingRole();
    await expect(
      svc.create({ name: 'X', code: 'x_role', permission_keys: ['role:manage'] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('PROTECTED_PERMISSION khi gán staff:manage', async () => {
    const { svc } = serviceWithNoExistingRole();
    await expect(
      svc.create({ name: 'X', code: 'x_role2', permission_keys: ['staff:manage'] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('ROLE_SYSTEM khi sửa permission_keys role hệ thống', async () => {
    const prisma = {
      role: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1n,
          isSystem: true,
          isActive: true,
          name: 'Admin',
          description: null,
        }),
        update: jest.fn(),
      },
      rolePermission: { deleteMany: jest.fn(), createMany: jest.fn() },
      permission: { findMany: jest.fn() },
    } as unknown as PrismaService;
    const svc = new RoleService(prisma, fakeAuthCache);
    await expect(
      svc.update('1', { permission_keys: ['order:view'] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
