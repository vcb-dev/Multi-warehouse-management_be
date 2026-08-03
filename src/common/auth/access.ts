import { ForbiddenException } from '@nestjs/common';
import type { AuthUser } from '../decorators/current-user.decorator';
import { BusinessException } from '../exceptions/business.exception';

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

/** Role admin là toàn hệ thống (mô hình Sapo) — không giới hạn theo kho. */
export function isAdminUser(user: AuthUser): boolean {
  return user.isAdmin === true;
}

/**
 * Kho user được gán role admin. Chỉ dùng để hiển thị/audit — muốn biết user có
 * được phép hay không thì dùng isAdminUser/hasPermission.
 */
export function isAdminAtWarehouse(
  user: AuthUser,
  locationId?: string | bigint,
): boolean {
  if (!locationId) return false;
  const wid = locationId.toString();
  return (user.adminWarehouseIds ?? []).some((id) => id.toString() === wid);
}

/** Quyền `scope=system`: hiệu lực toàn hệ thống, không phụ thuộc kho. */
export function hasSystemPermission(
  user: AuthUser,
  permission: string,
): boolean {
  if (isAdminUser(user)) return true;
  return (user.systemPermissions ?? []).includes(permission);
}

/** Quyền `scope=location`: chỉ hiệu lực tại kho được gán quyền đó. */
export function hasLocationPermission(
  user: AuthUser,
  permission: string,
  locationId?: string,
): boolean {
  if (isAdminUser(user)) return true;
  const byWh = user.warehousePermissions ?? {};
  if (locationId) return (byWh[locationId] ?? []).includes(permission);
  // Không xác định được kho: chỉ hợp lệ cho hành động ĐỌC (spec §5) — có quyền
  // ở ít nhất một kho là đủ, tầng service chịu trách nhiệm lọc dữ liệu trả về.
  return Object.values(byWh).some((perms) => perms.includes(permission));
}

/**
 * Không biết scope của permission thì thử cả hai tầng. Nơi nào biết scope
 * (PermissionGuard) nên gọi thẳng hasSystemPermission/hasLocationPermission.
 */
export function hasPermission(
  user: AuthUser,
  permission: string,
  locationId?: string,
): boolean {
  return (
    hasSystemPermission(user, permission) ||
    hasLocationPermission(user, permission, locationId)
  );
}

/**
 * Danh sách kho mà user có `permission`. Trả `undefined` nghĩa là KHÔNG giới hạn
 * (admin toàn hệ thống) — dùng để bỏ hẳn điều kiện lọc thay vì liệt kê id.
 */
export function locationsWithPermission(
  user: AuthUser,
  permission: string | string[],
): bigint[] | undefined {
  if (isAdminUser(user)) return undefined;
  const wanted = Array.isArray(permission) ? permission : [permission];
  return Object.entries(user.warehousePermissions ?? {})
    .filter(([, perms]) => wanted.some((w) => perms.includes(w)))
    .map(([id]) => BigInt(id));
}

/**
 * Điều kiện Prisma lọc theo kho user có quyền. `undefined` được Prisma hiểu là
 * "không lọc" nên gán thẳng vào `where.locationId` là đúng cho cả admin.
 *
 * Lọc theo kho CÓ QUYỀN, không phải kho ĐƯỢC GÁN: là thành viên một kho nhưng
 * role tại đó không có quyền đọc thì không được thấy dữ liệu kho ấy.
 */
export function locationScopeFilter(
  user: AuthUser,
  permission: string | string[],
): { in: bigint[] } | undefined {
  const ids = locationsWithPermission(user, permission);
  return ids ? { in: ids } : undefined;
}

/**
 * Kiểm quyền tại kho CỦA TÀI NGUYÊN — chốt chặn thật cho thao tác chéo kho.
 * Kho trong request do client tự khai nên không dùng làm căn cứ được; phải lấy
 * `locationId` từ bản ghi đã load lên rồi mới kiểm.
 */
export function assertLocationPermission(
  user: AuthUser,
  permission: string | string[],
  locationId: bigint | string,
): void {
  const wanted = Array.isArray(permission) ? permission : [permission];
  const ok = wanted.some((perm) =>
    hasLocationPermission(user, perm, locationId.toString()),
  );
  if (!ok) {
    throw new BusinessException(
      'FORBIDDEN_SCOPE',
      'Bạn không có quyền thao tác tại kho của dữ liệu này.',
      403,
    );
  }
}

export function assertLocationAccess(user: AuthUser, locationId: bigint): void {
  if (isAdminUser(user)) return;
  if (!user.locationIds.some((id) => id === locationId)) {
    throw new ForbiddenException('FORBIDDEN_SCOPE');
  }
}

export function assertAnyLocationAccess(
  user: AuthUser,
  locationIds: bigint[],
): void {
  if (isAdminUser(user)) return;
  const allowed = new Set(user.locationIds.map((id) => id.toString()));
  if (!locationIds.some((id) => allowed.has(id.toString()))) {
    throw new ForbiddenException('FORBIDDEN_SCOPE');
  }
}
