/**
 * AuthService.me() — dùng cho FE refresh quyền định kỳ (xem
 * frontend/src/lib/auth-options.ts). Phải trả đúng field mà FE parse
 * (`MePayload`), và khớp shape với `login()` — hai đường lệch nhau là FE parse
 * sai sau lần refresh đầu tiên mà không lỗi rõ ràng ở đâu.
 */
import { NotFoundException } from '@nestjs/common';
import { AuthService } from '../src/modules/auth/auth.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { JwtService } from '@nestjs/jwt';
import type { RbacService } from '../src/modules/rbac/rbac.service';

const baseUser = {
  id: 7n,
  email: 'u@test',
  firstName: 'Nguyễn',
  lastName: 'Văn A',
  active: true,
  status: 'active',
  passwordHash: 'hash',
  roles: ['sales'],
};

const resolved = {
  adminWarehouseIds: [],
  warehousePermissions: { '1': ['order:view'] },
  locationIds: [1n],
  systemPermissions: ['dashboard:view'],
  permissions: [],
  isAdmin: false,
};

function build(userRow: unknown = baseUser) {
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(userRow) },
  } as unknown as PrismaService;
  const jwt = {} as JwtService;
  const rbac = {
    resolvePermissions: jest.fn().mockResolvedValue(resolved),
  } as unknown as RbacService;
  return new AuthService(prisma, jwt, rbac);
}

describe('AuthService.me', () => {
  it('trả đúng shape mà FE mong đợi (MePayload)', async () => {
    const auth = build();
    const result = await auth.me(7n);
    expect(result).toEqual({
      user: {
        id: '7',
        email: 'u@test',
        name: 'Nguyễn Văn A',
        roles: ['sales'],
        location_ids: ['1'],
        warehouse_permissions: { '1': ['order:view'] },
        admin_location_ids: [],
        permissions: ['dashboard:view'],
        is_admin: false,
      },
    });
  });

  it('không trả access_token — không phát hành token mới ở đây', async () => {
    const auth = build();
    const result = await auth.me(7n);
    expect(result).not.toHaveProperty('access_token');
  });

  it('user không tồn tại -> NotFoundException', async () => {
    const auth = build(null);
    await expect(auth.me(999n)).rejects.toBeInstanceOf(NotFoundException);
  });
});
