import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export type AuthUser = {
  userId: bigint;
  email: string;
  roles: string[];
  locationIds: bigint[];
  /** @deprecated Không dùng bypass toàn cục — dùng adminWarehouseIds. */
  isAdmin?: boolean;
  /** Kho mà user mang role admin. */
  adminWarehouseIds?: bigint[];
  /** @deprecated Quyền gom trong warehousePermissions theo từng kho. */
  systemPermissions?: string[];
  /** @deprecated Dùng warehousePermissions. */
  permissions?: string[];
  /** Quyền hiệu lực theo từng kho (gồm cả permission scope=system của role tại kho đó). */
  warehousePermissions?: Record<string, string[]>;
};

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest<{ user: AuthUser }>();
    return req.user;
  },
);
