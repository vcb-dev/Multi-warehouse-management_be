import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';
import { AuthCacheService } from '../rbac/auth-cache.service';
import { userDisplayName } from '../../common/utils/user-display-name';
import type { User } from '@prisma/client';
import type { ResolvedPermissions } from '../rbac/rbac.service';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private rbac: RbacService,
    private authCache: AuthCacheService,
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

  async login(email: string, password: string) {
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
    const token = await this.jwt.signAsync({
      sub: user.id.toString(),
      email: user.email,
      ver: user.tokenVersion,
    });

    return {
      access_token: token,
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

  /**
   * Vô hiệu hoá MỌI token đã phát cho user — đăng xuất toàn bộ thiết bị.
   *
   * Đăng xuất thường chỉ xoá cookie tại máy đang dùng, token vẫn sống tới khi hết
   * hạn (7 ngày); đây là đường duy nhất thu hồi thật. Vì đá văng cả thiết bị khác
   * nên tách riêng, không gộp vào nút đăng xuất bình thường.
   *
   * Phải xoá cache quyền ngay: `JwtStrategy` trả cache TRƯỚC khi tra DB, không xoá
   * thì token vừa thu hồi vẫn đi lọt tới hết TTL 30s.
   */
  async revokeAllSessions(userId: bigint) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });
    this.authCache.invalidate(userId);
    return { data: { revoked: true, token_version: user.tokenVersion } };
  }
}
