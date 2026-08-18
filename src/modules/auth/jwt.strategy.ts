import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { RbacService } from '../rbac/rbac.service';
import { AuthCacheService } from '../rbac/auth-cache.service';
import { requireEnv } from '../../common/utils/require-env';

type JwtPayload = { sub: string; email: string; ver?: number };

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private prisma: PrismaService,
    private rbac: RbacService,
    private authCache: AuthCacheService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: requireEnv(config, 'JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    const cached = this.authCache.get(payload.sub);
    if (cached) {
      // Cache theo userId nên dùng chung cho mọi token của user. Không so ở đây thì
      // sau khi thu hồi, chỉ cần user đăng nhập lại là entry cache mới nạp lên và
      // token cũ bám theo đó đi lọt.
      if ((payload.ver ?? 0) !== (cached.tokenVersion ?? 0)) {
        throw new UnauthorizedException();
      }
      return cached;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: BigInt(payload.sub) },
      include: { locations: true, locationRoles: true },
    });
    if (!user || !user.active || user.status === 'inactive') {
      this.authCache.invalidate(payload.sub);
      throw new UnauthorizedException();
    }
    // Token phát trước lần thu hồi gần nhất -> từ chối. `ver` vắng mặt nghĩa là token
    // ký bởi bản cũ (trước khi có tokenVersion), coi như phiên bản 0 để những token
    // đang lưu hành lúc triển khai không bị đá hàng loạt ngoài ý muốn.
    if ((payload.ver ?? 0) !== user.tokenVersion) {
      this.authCache.invalidate(payload.sub);
      throw new UnauthorizedException();
    }
    const resolved = await this.rbac.resolvePermissions(user.id);
    const authUser: AuthUser = {
      userId: user.id,
      email: user.email,
      roles: user.roles,
      locationIds: resolved.locationIds,
      isAdmin: resolved.isAdmin,
      adminWarehouseIds: resolved.adminWarehouseIds,
      systemPermissions: resolved.systemPermissions,
      permissions: resolved.systemPermissions,
      warehousePermissions: resolved.warehousePermissions,
      tokenVersion: user.tokenVersion,
    };
    this.authCache.set(payload.sub, authUser);
    return authUser;
  }
}
