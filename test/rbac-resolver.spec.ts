/**
 * Unit test RbacService.resolvePermissions — quyền theo kho, admin theo kho.
 */
import { PermissionScope } from '@prisma/client';
import { RbacService } from '../src/modules/rbac/rbac.service';
import type { PrismaService } from '../src/prisma/prisma.service';

function fakePrisma(rows: unknown[], overrides: unknown[] = []): PrismaService {
  return {
    userLocationRole: {
      findMany: jest.fn().mockResolvedValue(rows),
    },
    // resolvePermissions truy vấn song song cả lệch quyền riêng của user
    userPermissionOverride: {
      findMany: jest.fn().mockResolvedValue(overrides),
    },
  } as unknown as PrismaService;
}

const perm = (key: string, scope: PermissionScope = PermissionScope.location) => ({
  permission: { key, scope },
});

describe('RbacService.resolvePermissions', () => {
  it('gom mọi permission vào warehousePermissions theo từng kho', async () => {
    const prisma = fakePrisma([
      {
        locationId: 1n,
        role: {
          isSystem: false,
          code: 'sales',
          permissions: [
            perm('order:view'),
            perm('order:pack'),
            perm('customer:view', PermissionScope.system),
          ],
        },
      },
      {
        locationId: 2n,
        role: {
          isSystem: false,
          code: 'sales',
          permissions: [perm('order:view'), perm('product:view')],
        },
      },
    ]);
    const svc = new RbacService(prisma);
    const res = await svc.resolvePermissions(1n);

    expect(res.systemPermissions).toEqual([]);
    expect(new Set(res.warehousePermissions['1'])).toEqual(
      new Set(['order:view', 'order:pack', 'customer:view']),
    );
    expect(new Set(res.warehousePermissions['2'])).toEqual(
      new Set(['order:view', 'product:view']),
    );
    expect(res.locationIds).toEqual([1n, 2n]);
    expect(res.isAdmin).toBe(false);
    expect(res.adminWarehouseIds).toEqual([]);
  });

  it('adminWarehouseIds khi gán role admin tại kho', async () => {
    const prisma = fakePrisma([
      {
        locationId: 1n,
        role: {
          isSystem: true,
          code: 'admin',
          permissions: [perm('role:manage', PermissionScope.system)],
        },
      },
    ]);
    const res = await new RbacService(prisma).resolvePermissions(1n);
    expect(res.adminWarehouseIds).toEqual([1n]);
    expect(res.isAdmin).toBe(true);
    expect(res.warehousePermissions['1']).toContain('role:manage');
  });

  it('user không có gán role -> rỗng', async () => {
    const svc = new RbacService(fakePrisma([]));
    const res = await svc.resolvePermissions(99n);
    expect(res.systemPermissions).toEqual([]);
    expect(res.warehousePermissions).toEqual({});
    expect(res.isAdmin).toBe(false);
    expect(res.adminWarehouseIds).toEqual([]);
  });
});
