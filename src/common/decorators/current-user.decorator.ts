import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export type AuthUser = {
  userId: bigint;
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
  /**
   * Phiên bản token tại thời điểm dựng bản ghi này. Cache quyền dùng chung theo
   * userId cho MỌI token của user (kể cả API key), nên phải mang theo để nhánh
   * cache còn đối chiếu được — thiếu nó thì token đã thu hồi vẫn đi lọt bằng cách
   * bám vào entry cache do một token hợp lệ khác nạp lên.
   */
  tokenVersion?: number;
};

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest<{ user: AuthUser }>();
    return req.user;
  },
);
