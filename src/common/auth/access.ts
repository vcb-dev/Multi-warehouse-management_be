import { ForbiddenException } from '@nestjs/common';
import type { AuthUser } from '../decorators/current-user.decorator';

export function resolveWarehouseId(sources: {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
}): string | undefined {
  const header = sources.headers?.['x-warehouse-id'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  return (
    sources.params?.warehouseId ??
    (sources.query?.warehouse_id as string | undefined) ??
    (sources.body?.warehouse_id as string | undefined) ??
    fromHeader
  );
}

/** User có role admin tại kho cụ thể — không bypass toàn hệ thống. */
export function isAdminAtWarehouse(
  user: AuthUser,
  warehouseId?: string | bigint,
): boolean {
  if (!warehouseId) return false;
  const wid = warehouseId.toString();
  return (user.adminWarehouseIds ?? []).some((id) => id.toString() === wid);
}

/** @deprecated Dùng isAdminAtWarehouse(user, warehouseId). Không còn bypass toàn cục. */
export function isAdminUser(user: AuthUser, warehouseId?: string | bigint): boolean {
  return isAdminAtWarehouse(user, warehouseId);
}

function effectivePermissions(user: AuthUser, warehouseId?: string): string[] {
  if (!warehouseId) return [];
  return user.warehousePermissions?.[warehouseId] ?? [];
}

export function hasPermission(
  user: AuthUser,
  permission: string,
  warehouseId?: string,
): boolean {
  if (warehouseId && isAdminAtWarehouse(user, warehouseId)) return true;
  if (warehouseId) {
    return effectivePermissions(user, warehouseId).includes(permission);
  }
  const byWh = user.warehousePermissions ?? {};
  return Object.entries(byWh).some(
    ([whId, perms]) =>
      isAdminAtWarehouse(user, whId) || perms.includes(permission),
  );
}

export function hasSystemPermission(
  user: AuthUser,
  permission: string,
  warehouseId?: string,
): boolean {
  return hasPermission(user, permission, warehouseId);
}

export function hasWarehousePermission(
  user: AuthUser,
  permission: string,
  warehouseId?: string,
): boolean {
  return hasPermission(user, permission, warehouseId);
}

export function assertWarehouseAccess(user: AuthUser, warehouseId: bigint): void {
  if (!user.warehouseIds.some((id) => id === warehouseId)) {
    throw new ForbiddenException('FORBIDDEN_SCOPE');
  }
}

export function assertAnyWarehouseAccess(user: AuthUser, warehouseIds: bigint[]): void {
  const allowed = new Set(user.warehouseIds.map((id) => id.toString()));
  if (!warehouseIds.some((id) => allowed.has(id.toString()))) {
    throw new ForbiddenException('FORBIDDEN_SCOPE');
  }
}
