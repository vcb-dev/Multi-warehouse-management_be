import { Injectable } from '@nestjs/common';
import { PermissionScope } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export type ResolvedPermissions = {
  isAdmin: boolean;
  systemPermissions: string[];
  warehousePermissions: Record<string, string[]>;
  warehouseIds: bigint[];
  /** @deprecated Dùng systemPermissions — giữ tương thích ngắn hạn. */
  permissions: string[];
};

@Injectable()
export class RbacService {
  constructor(private prisma: PrismaService) {}

  /**
   * Phân giải quyền từ user_warehouse_roles -> role_permissions.
   * Quyền system gom toàn cục; quyền warehouse chỉ theo từng kho.
   */
  async resolvePermissions(userId: bigint): Promise<ResolvedPermissions> {
    const assignments = await this.prisma.userWarehouseRole.findMany({
      where: { userId, role: { isActive: true } },
      include: {
        role: {
          include: {
            permissions: { include: { permission: true } },
          },
        },
      },
    });

    const systemPerms = new Set<string>();
    const byWarehouse: Record<string, Set<string>> = {};
    const warehouseIds: bigint[] = [];
    let isAdmin = false;

    for (const a of assignments) {
      warehouseIds.push(a.warehouseId);
      if (a.role.isSystem && a.role.code === 'admin') {
        isAdmin = true;
      }

      const whKey = a.warehouseId.toString();
      byWarehouse[whKey] ??= new Set<string>();

      for (const rp of a.role.permissions) {
        const { key, scope } = rp.permission;
        if (scope === PermissionScope.system) {
          systemPerms.add(key);
        } else {
          byWarehouse[whKey].add(key);
        }
      }
    }

    const systemPermissions = [...systemPerms];
    const warehousePermissions = Object.fromEntries(
      Object.entries(byWarehouse).map(([k, v]) => [k, [...v]]),
    );

    return {
      isAdmin,
      systemPermissions,
      warehousePermissions,
      warehouseIds,
      permissions: systemPermissions,
    };
  }
}
