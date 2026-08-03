import { Injectable } from '@nestjs/common';
import { PermissionScope } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export type ResolvedPermissions = {
  /** Kho được gán role admin — chỉ để hiển thị/audit, không quyết định quyền. */
  adminWarehouseIds: bigint[];
  /** Quyền `scope=location`, hiệu lực riêng tại từng kho. */
  warehousePermissions: Record<string, string[]>;
  locationIds: bigint[];
  /** Quyền `scope=system` — hiệu lực toàn hệ thống, không gắn kho. */
  systemPermissions: string[];
  /** @deprecated Dùng systemPermissions. */
  permissions: string[];
  /** Mang role admin ở bất kỳ kho nào → toàn quyền toàn hệ thống. */
  isAdmin: boolean;
};

@Injectable()
export class RbacService {
  constructor(private prisma: PrismaService) {}

  /**
   * Hai tầng quyền tách bạch (specs/009-cau-hinh/research.md §5):
   * - `scope=system`: union từ MỌI role của user, hiệu lực toàn hệ thống.
   * - `scope=location`: chỉ hiệu lực tại kho mà role đó được gán.
   */
  async resolvePermissions(userId: bigint): Promise<ResolvedPermissions> {
    const [assignments, overrides] = await Promise.all([
      this.prisma.userLocationRole.findMany({
        where: { userId, role: { isActive: true } },
        include: {
          role: {
            include: {
              permissions: { include: { permission: true } },
            },
          },
        },
      }),
      this.prisma.userPermissionOverride.findMany({
        where: { userId },
        include: { permission: true },
      }),
    ]);

    const byWarehouse: Record<string, Set<string>> = {};
    const systemPermissions = new Set<string>();
    const locationIds: bigint[] = [];
    const adminWarehouseIds: bigint[] = [];

    for (const a of assignments) {
      locationIds.push(a.locationId);
      const whKey = a.locationId.toString();
      byWarehouse[whKey] ??= new Set<string>();

      if (a.role.isSystem && a.role.code === 'admin') {
        adminWarehouseIds.push(a.locationId);
      }

      for (const rp of a.role.permissions) {
        if (rp.permission.scope === PermissionScope.system) {
          systemPermissions.add(rp.permission.key);
        } else {
          byWarehouse[whKey].add(rp.permission.key);
        }
      }
    }

    // Lệch quyền riêng (nhân viên) chồng lên quyền mặc định của role tại kho.
    // Quyền `scope=system` không gắn kho nên override theo kho là vô nghĩa —
    // bỏ qua ở đây, đường ghi đã chặn từ trước (UserAdminService).
    for (const o of overrides) {
      if (o.permission.scope === PermissionScope.system) continue;
      const whKey = o.locationId.toString();
      const set = (byWarehouse[whKey] ??= new Set<string>());
      if (o.granted) set.add(o.permission.key);
      else set.delete(o.permission.key);
    }

    const warehousePermissions = Object.fromEntries(
      Object.entries(byWarehouse).map(([k, v]) => [k, [...v]]),
    );

    return {
      adminWarehouseIds,
      warehousePermissions,
      locationIds,
      systemPermissions: [...systemPermissions],
      permissions: [],
      isAdmin: adminWarehouseIds.length > 0,
    };
  }
}
