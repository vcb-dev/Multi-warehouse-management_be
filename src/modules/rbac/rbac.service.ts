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

  /**
   * Chiều NGƯỢC của `resolvePermissions`: cho một tập quyền, ai là người có ĐỦ cả tập
   * đó (tại `locationId` nếu quyền là scope=location)? Dùng để fan-out thông báo.
   *
   * Đặt ở đây chứ không ở NotificationService để luật RBAC chỉ tồn tại đúng một chỗ —
   * hai tầng quyền system/location, override theo kho, admin toàn quyền đều là những
   * chi tiết rất dễ hiện thực lệch nếu viết lại lần hai.
   *
   * Nạp toàn bộ assignment rồi lọc trong bộ nhớ thay vì dựng SQL: hệ thống có ~9 tài
   * khoản nội bộ (tối đa vài chục), nên chi phí không đáng kể, đổi lại logic lọc dùng
   * lại nguyên vẹn cách `resolvePermissions` diễn giải dữ liệu.
   *
   * @param locationId Kho phát sinh sự kiện. `null` = sự kiện không thuộc kho nào ⇒
   *   quyền scope=location được tính là thoả nếu user có nó ở BẤT KỲ kho nào.
   */
  async usersWithPermissions(
    keys: string[],
    locationId: bigint | null,
  ): Promise<bigint[]> {
    const [assignments, overrides] = await Promise.all([
      this.prisma.userLocationRole.findMany({
        where: {
          role: { isActive: true },
          user: { active: true, status: 'active' },
        },
        include: {
          role: { include: { permissions: { include: { permission: true } } } },
        },
      }),
      this.prisma.userPermissionOverride.findMany({
        include: { permission: true },
      }),
    ]);

    // userId -> quyền hiệu lực (đã gộp system + location đúng kho đang xét)
    const effective = new Map<string, Set<string>>();
    const admins = new Set<string>();
    const candidates = new Set<string>();

    for (const a of assignments) {
      const uid = a.userId.toString();
      candidates.add(uid);
      const set = effective.get(uid) ?? new Set<string>();
      effective.set(uid, set);

      if (a.role.isSystem && a.role.code === 'admin') admins.add(uid);

      const locationMatches =
        locationId === null || a.locationId === locationId;

      for (const rp of a.role.permissions) {
        // Quyền system có hiệu lực bất kể role được gán ở kho nào.
        if (rp.permission.scope === PermissionScope.system) {
          set.add(rp.permission.key);
        } else if (locationMatches) {
          set.add(rp.permission.key);
        }
      }
    }

    for (const o of overrides) {
      // Giống resolvePermissions: override chỉ áp cho quyền scope=location.
      if (o.permission.scope === PermissionScope.system) continue;
      if (locationId !== null && o.locationId !== locationId) continue;
      const set = effective.get(o.userId.toString());
      if (!set) continue;
      if (o.granted) set.add(o.permission.key);
      else set.delete(o.permission.key);
    }

    const matched = [...candidates].filter((uid) => {
      if (admins.has(uid)) return true; // admin = toàn quyền, giống isAdminUser()
      const set = effective.get(uid);
      return keys.every((k) => set?.has(k));
    });

    return matched.map((uid) => BigInt(uid));
  }
}
