import { SetMetadata } from '@nestjs/common';

export const API_SCOPE_KEY = 'requiredApiScopes';

/**
 * Yêu cầu API key có ít nhất MỘT trong các scope liệt kê. Kiểm tra trong `ApiKeyGuard`
 * (song song với `RequirePermission`/`PermissionGuard` dùng cho JWT nội bộ).
 */
export const RequireApiScope = (...scopes: string[]) =>
  SetMetadata(API_SCOPE_KEY, scopes);
