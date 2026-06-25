import { ForbiddenException } from '@nestjs/common';
import type { AuthUser } from '../decorators/current-user.decorator';

/** User gán role hệ thống `admin` — bypass scope/guard. */
export function isAdminUser(user: AuthUser): boolean {
  return user.isAdmin === true;
}

export function hasSystemPermission(user: AuthUser, permission: string): boolean {
  if (isAdminUser(user)) return true;
  const perms = user.systemPermissions ?? user.permissions ?? [];
  return perms.includes(permission);
}

/** Kiểm tra quyền warehouse: theo kho cụ thể hoặc bất kỳ kho nào user được gán. */
export function hasWarehousePermission(
  user: AuthUser,
  permission: string,
  warehouseId?: string,
): boolean {
  if (isAdminUser(user)) return true;
  const byWh = user.warehousePermissions ?? {};
  if (warehouseId) {
    return (byWh[warehouseId] ?? []).includes(permission);
  }
  return Object.values(byWh).some((perms) => perms.includes(permission));
}

export function assertWarehouseAccess(user: AuthUser, warehouseId: bigint): void {
  if (isAdminUser(user)) return;
  if (!user.warehouseIds.some((id) => id === warehouseId)) {
    throw new ForbiddenException('FORBIDDEN_SCOPE');
  }
}

export function assertAnyWarehouseAccess(user: AuthUser, warehouseIds: bigint[]): void {
  if (isAdminUser(user)) return;
  const allowed = new Set(user.warehouseIds.map((id) => id.toString()));
  if (!warehouseIds.some((id) => allowed.has(id.toString()))) {
    throw new ForbiddenException('FORBIDDEN_SCOPE');
  }
}
