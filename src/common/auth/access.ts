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
    sources.params?.locationId ??
    (sources.query?.location_id as string | undefined) ??
    (sources.body?.location_id as string | undefined) ??
    fromHeader
  );
}

/** User có role admin tại kho cụ thể — không bypass toàn hệ thống. */
export function isAdminAtWarehouse(
  user: AuthUser,
  locationId?: string | bigint,
): boolean {
  if (!locationId) return false;
  const wid = locationId.toString();
  return (user.adminWarehouseIds ?? []).some((id) => id.toString() === wid);
}

/** @deprecated Dùng isAdminAtWarehouse(user, locationId). Không còn bypass toàn cục. */
export function isAdminUser(user: AuthUser, locationId?: string | bigint): boolean {
  return isAdminAtWarehouse(user, locationId);
}

function effectivePermissions(user: AuthUser, locationId?: string): string[] {
  if (!locationId) return [];
  return user.warehousePermissions?.[locationId] ?? [];
}

export function hasPermission(
  user: AuthUser,
  permission: string,
  locationId?: string,
): boolean {
  if (locationId && isAdminAtWarehouse(user, locationId)) return true;
  if (locationId) {
    return effectivePermissions(user, locationId).includes(permission);
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
  locationId?: string,
): boolean {
  return hasPermission(user, permission, locationId);
}

export function hasWarehousePermission(
  user: AuthUser,
  permission: string,
  locationId?: string,
): boolean {
  return hasPermission(user, permission, locationId);
}

export function assertLocationAccess(user: AuthUser, locationId: bigint): void {
  if (!user.locationIds.some((id) => id === locationId)) {
    throw new ForbiddenException('FORBIDDEN_SCOPE');
  }
}

export function assertAnyLocationAccess(user: AuthUser, locationIds: bigint[]): void {
  const allowed = new Set(user.locationIds.map((id) => id.toString()));
  if (!locationIds.some((id) => allowed.has(id.toString()))) {
    throw new ForbiddenException('FORBIDDEN_SCOPE');
  }
}
