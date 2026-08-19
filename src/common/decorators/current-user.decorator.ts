import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export type AuthUser = {
  userId: bigint;
  /**
   * Phiên đang dùng. Có với người đăng nhập, KHÔNG có với đường API key đối tác — key
   * không thuộc phiên nào nên không tự đăng xuất hay tự liệt kê thiết bị được.
   */
  sessionId?: bigint;
  email: string;
  roles: string[];
  locationIds: bigint[];
  /** Mang role admin → toàn quyền toàn hệ thống (mô hình Sapo). */
  isAdmin?: boolean;
  /** Kho mà user mang role admin — chỉ để hiển thị/audit, không quyết định quyền. */
  adminWarehouseIds?: bigint[];
  /** Quyền `scope=system`: hiệu lực toàn hệ thống, không gắn kho. */
  systemPermissions?: string[];
  /** @deprecated Dùng systemPermissions. */
  permissions?: string[];
  /** Quyền `scope=location`: hiệu lực riêng tại từng kho. */
  warehousePermissions?: Record<string, string[]>;
};

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest<{ user: AuthUser }>();
    return req.user;
  },
);
