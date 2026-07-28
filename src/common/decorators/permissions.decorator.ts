import { SetMetadata } from '@nestjs/common';

export const PERMISSION_KEY = 'requiredPermissions';

/**
 * Yêu cầu user có ít nhất MỘT trong các quyền liệt kê.
 * Quyền scope=warehouse được kiểm tra theo kho trong request (params/query/body location_id).
 */
export const RequirePermission = (...permissions: string[]) =>
  SetMetadata(PERMISSION_KEY, permissions);
