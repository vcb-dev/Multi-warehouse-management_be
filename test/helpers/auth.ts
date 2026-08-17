import type { AuthUser } from '../../src/common/decorators/current-user.decorator';

/**
 * Dựng AuthUser cho test.
 *
 * Quyền admin được quyết định bởi cờ `isAdmin` (resolve ở RbacService, gắn vào request ở
 * JwtStrategy) chứ KHÔNG phải mảng `roles` — `isAdminUser()` chỉ đọc `user.isAdmin`.
 * Test dựng AuthUser bằng tay nên không đi qua đường resolve đó; helper này là nơi duy
 * nhất giữ cho fixture khớp với mô hình quyền, thay vì rải object rời trong từng file.
 */
export const adminAuth = (over: Partial<AuthUser> = {}): AuthUser => ({
  userId: 0n,
  email: 'admin@local.dev',
  roles: ['admin'],
  locationIds: [],
  isAdmin: true,
  ...over,
});

/**
 * User thường: không có `isAdmin`, quyền cấp theo từng kho qua `warehousePermissions`.
 * Dùng cho các test kiểm chốt chặn FORBIDDEN_SCOPE.
 */
export const staffAuth = (
  over: Partial<AuthUser> & {
    warehousePermissions?: Record<string, string[]>;
  } = {},
): AuthUser => ({
  userId: 0n,
  email: 'staff@local.dev',
  roles: ['warehouse_staff'],
  locationIds: [],
  isAdmin: false,
  systemPermissions: [],
  warehousePermissions: {},
  ...over,
});
