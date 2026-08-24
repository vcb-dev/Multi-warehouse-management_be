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
import {
  TokenService,
  type SessionContext,
  type TokenPair,
} from './token.service';

export type AuthResult = {
  tokens: TokenPair;
  body: {
    user: ReturnType<AuthService['buildUserPayload']>;
    expires_at: string;
  };
};

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private rbac: RbacService,
    private tokens: TokenService,
  ) {}

  /**
   * Payload quyền trả cho FE — dùng chung cho login, refresh và `/auth/me` để ba đường
   * không lệch shape với nhau.
   *
   * KHÔNG chứa token: cả access lẫn refresh đều đi bằng cookie `httpOnly`, nên JavaScript
   * ở trình duyệt không đọc được chúng. Trả thêm một bản trong body là tự tay huỷ lợi ích
   * đó — chỉ cần một lỗ XSS là token bị đọc và mang đi.
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

  async login(
    email: string,
    password: string,
    ctx: SessionContext = {},
  ): Promise<AuthResult> {
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
    const tokens = await this.tokens.issueForLogin(user.id, ctx);

    return {
      tokens,
      body: {
        user: this.buildUserPayload(user, resolved),
        // Hạn của REFRESH token, không phải access token: đây là mốc người dùng thật sự
        // phải gõ lại mật khẩu. Access token xoay vòng ngầm sau lưng, FE không cần biết.
        expires_at: tokens.refreshExpiresAt.toISOString(),
      },
    };
  }

  /**
   * Đổi refresh token lấy cặp mới. Trả luôn payload quyền mới nhất để FE không phải gọi
   * thêm `/auth/me` sau mỗi lần gia hạn — đổi role ở BE vì thế cũng vào FE trong vòng một
   * chu kỳ access token.
   */
  async refresh(
    rawRefreshToken: string | undefined,
    ctx: SessionContext = {},
  ): Promise<AuthResult> {
    if (!rawRefreshToken) throw new UnauthorizedException();

    const rotated = await this.tokens.rotate(rawRefreshToken, ctx);
    if (!rotated) throw new UnauthorizedException();

    const user = await this.prisma.user.findUnique({
      where: { id: rotated.userId },
    });
    if (!user) throw new UnauthorizedException();
    const resolved = await this.rbac.resolvePermissions(user.id);

    return {
      tokens: rotated.pair,
      body: {
        user: this.buildUserPayload(user, resolved),
        expires_at: rotated.pair.refreshExpiresAt.toISOString(),
      },
    };
  }

  /**
   * Đăng xuất. Thử LẦN LƯỢT mọi token người dùng còn cầm, vì hai cookie hỏng ở hai kiểu
   * khác nhau và hiếm khi hỏng cùng lúc: refresh cookie chỉ được gửi cho `/api/auth` nên
   * dễ vắng mặt, còn access cookie thì luôn được gửi nhưng hay đã hết hạn. Cả hai đều
   * chở cùng một `familyId`, nên còn cái nào đọc được là thu hồi được cả họ.
   *
   * Chỉ xoá cookie mà không tới được đây là đăng xuất giả: trình duyệt NÀY quên token,
   * còn bản token thì sống tiếp tới hết 7 ngày và ai copy được vẫn dùng bình thường.
   */
  async logout(...rawTokens: (string | undefined)[]): Promise<boolean> {
    for (const raw of rawTokens) {
      const family = raw ? this.tokens.familyOf(raw) : null;
      if (family) return (await this.tokens.revokeFamily(family)) > 0;
    }
    return false;
  }

  /**
   * Quyền hiện tại của user đang đăng nhập — FE gọi lúc mở app và định kỳ để đồng bộ lại
   * (đổi role/quyền có hiệu lực mà không cần đăng nhập lại).
   */
  async me(userId: bigint) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('USER_NOT_FOUND');
    const resolved = await this.rbac.resolvePermissions(user.id);
    return { user: this.buildUserPayload(user, resolved) };
  }
}
