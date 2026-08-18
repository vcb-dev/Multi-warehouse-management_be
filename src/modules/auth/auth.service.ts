import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';
import { userDisplayName } from '../../common/utils/user-display-name';
import type { User } from '@prisma/client';
import type { ResolvedPermissions } from '../rbac/rbac.service';
import { SessionService, type SessionContext } from './session.service';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private rbac: RbacService,
    private sessions: SessionService,
  ) {}

  /**
   * Payload quyền trả cho FE — dùng chung cho login và `/auth/me` (refresh
   * định kỳ) để hai đường không lệch shape với nhau.
   */
  private buildUserPayload(user: User, resolved: ResolvedPermissions) {
    return {
      id: user.id.toString(),
      email: user.email,
      name: userDisplayName(user),
      roles: user.roles,
      location_ids: resolved.locationIds.map((w) => w.toString()),
      warehouse_permissions: resolved.warehousePermissions,
      admin_location_ids: resolved.adminWarehouseIds.map((w) => w.toString()),
      permissions: resolved.systemPermissions,
      is_admin: resolved.isAdmin,
    };
  }

  async login(email: string, password: string, ctx: SessionContext = {}) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.active || user.status === 'inactive') {
      throw new UnauthorizedException('Email hoặc mật khẩu không đúng');
    }
    if (!user.passwordHash) {
      throw new UnauthorizedException(
        'Tài khoản chưa kích hoạt. Vui lòng kiểm tra email lời mời.',
      );
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Email hoặc mật khẩu không đúng');
    }

    const resolved = await this.rbac.resolvePermissions(user.id);
    // Token là chuỗi ngẫu nhiên gắn với một dòng `user_sessions`, không phải JWT: thu hồi
    // được từng phiên, và không có khoá ký nào để dò ngược từ token bắt được.
    const session = await this.sessions.create(user.id, ctx);

    return {
      access_token: session.token,
      expires_at: session.expiresAt.toISOString(),
      user: this.buildUserPayload(user, resolved),
    };
  }

  /**
   * Quyền hiện tại của user đang đăng nhập — FE gọi định kỳ để đồng bộ lại
   * session (đổi role/quyền có hiệu lực mà không cần đăng nhập lại). Không có
   * `access_token` vì token vẫn dùng cái cũ, chỉ mỗi phần quyền là mới.
   */
  async me(userId: bigint) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('USER_NOT_FOUND');
    const resolved = await this.rbac.resolvePermissions(user.id);
    return { user: this.buildUserPayload(user, resolved) };
  }
}
