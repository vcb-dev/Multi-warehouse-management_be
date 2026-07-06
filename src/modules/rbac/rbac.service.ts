import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export type ResolvedPermissions = {
  /** Kho mà user được gán role admin — quyền admin chỉ hiệu lực tại từng kho này. */
  adminWarehouseIds: bigint[];
  warehousePermissions: Record<string, string[]>;
  warehouseIds: bigint[];
  /** @deprecated Quyền gom theo kho; field giữ cho tương thích login cũ. */
  systemPermissions: string[];
  /** @deprecated Dùng adminWarehouseIds + warehousePermissions. */
  permissions: string[];
  /** @deprecated true nếu có admin ở ít nhất một kho — không dùng bypass toàn cục. */
  isAdmin: boolean;
};

@Injectable()
export class RbacService {
  constructor(private prisma: PrismaService) {}

  /**
   * Quyền hiệu lực tại kho K = mọi permission (system + warehouse) của role tại K.
   */
  async resolvePermissions(userId: bigint): Promise<ResolvedPermissions> {
    const [assignments, overrides] = await Promise.all([
      this.prisma.userWarehouseRole.findMany({
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
    const warehouseIds: bigint[] = [];
    const adminWarehouseIds: bigint[] = [];

    for (const a of assignments) {
      warehouseIds.push(a.warehouseId);
      const whKey = a.warehouseId.toString();
      byWarehouse[whKey] ??= new Set<string>();

      if (a.role.isSystem && a.role.code === 'admin') {
        adminWarehouseIds.push(a.warehouseId);
      }

      for (const rp of a.role.permissions) {
        byWarehouse[whKey].add(rp.permission.key);
      }
    }

    // Lệch quyền riêng (nhân viên) chồng lên quyền mặc định của role tại kho —
    // bỏ qua với kho user đang là admin (admin luôn full quyền, không override).
    for (const o of overrides) {
      const whKey = o.warehouseId.toString();
      if (adminWarehouseIds.some((id) => id === o.warehouseId)) continue;
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
      warehouseIds,
      systemPermissions: [],
      permissions: [],
      isAdmin: adminWarehouseIds.length > 0,
    };
  }
}
