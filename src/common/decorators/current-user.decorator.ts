import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export type AuthUser = {
  userId: bigint;
  email: string;
  roles: string[];
  warehouseIds: bigint[];
  isAdmin?: boolean;
  /** Quyền scope=system (không theo kho). */
  systemPermissions?: string[];
  /** @deprecated Dùng systemPermissions. */
  permissions?: string[];
  /** Quyền scope=warehouse theo từng kho. */
  warehousePermissions?: Record<string, string[]>;
};

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest<{ user: AuthUser }>();
    return req.user;
  },
);
