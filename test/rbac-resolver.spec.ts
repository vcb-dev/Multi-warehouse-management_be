/**
 * Unit test RbacService.resolvePermissions — system vs warehouse, isAdmin.
 */
import { PermissionScope } from '@prisma/client';
import { RbacService } from '../src/modules/rbac/rbac.service';
import type { PrismaService } from '../src/prisma/prisma.service';

function fakePrisma(rows: unknown[]): PrismaService {
  return {
    userWarehouseRole: {
      findMany: jest.fn().mockResolvedValue(rows),
    },
  } as unknown as PrismaService;
}

const perm = (key: string, scope: PermissionScope = PermissionScope.warehouse) => ({
  permission: { key, scope },
});

describe('RbacService.resolvePermissions', () => {
  it('tách system vs warehouse permissions', async () => {
    const prisma = fakePrisma([
      {
        warehouseId: 1n,
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
        warehouseId: 2n,
        role: {
          isSystem: false,
          code: 'sales',
          permissions: [perm('order:view'), perm('product:view')],
        },
      },
    ]);
    const svc = new RbacService(prisma);
    const res = await svc.resolvePermissions(1n);

    expect(new Set(res.systemPermissions)).toEqual(new Set(['customer:view']));
    expect(new Set(res.warehousePermissions['1'])).toEqual(
      new Set(['order:view', 'order:pack']),
    );
    expect(new Set(res.warehousePermissions['2'])).toEqual(
      new Set(['order:view', 'product:view']),
    );
    expect(res.warehouseIds).toEqual([1n, 2n]);
    expect(res.isAdmin).toBe(false);
  });

  it('isAdmin khi gán role admin hệ thống', async () => {
    const prisma = fakePrisma([
      {
        warehouseId: 1n,
        role: {
          isSystem: true,
          code: 'admin',
          permissions: [perm('role:manage', PermissionScope.system)],
        },
      },
    ]);
    const res = await new RbacService(prisma).resolvePermissions(1n);
    expect(res.isAdmin).toBe(true);
  });

  it('user không có gán role -> rỗng', async () => {
    const svc = new RbacService(fakePrisma([]));
    const res = await svc.resolvePermissions(99n);
    expect(res.systemPermissions).toEqual([]);
    expect(res.warehousePermissions).toEqual({});
    expect(res.isAdmin).toBe(false);
  });
});
