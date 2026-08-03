import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { RbacService } from '../rbac/rbac.service';
import { AuthCacheService } from '../rbac/auth-cache.service';
import { requireEnv } from '../../common/utils/require-env';

type JwtPayload = { sub: string; email: string };

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
    if (cached) return cached;

    const user = await this.prisma.user.findUnique({
      where: { id: BigInt(payload.sub) },
      include: { locations: true, locationRoles: true },
    });
    if (!user || !user.active || user.status === 'inactive') {
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
    };
    this.authCache.set(payload.sub, authUser);
    return authUser;
  }
}
