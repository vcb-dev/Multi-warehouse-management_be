import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { RbacService } from '../rbac/rbac.service';

type JwtPayload = { sub: string; email: string };

// Mọi request đều chạy validate() nên phải cache: tránh 2 round-trip DB
// (user + permissions) lặp lại trên từng API call. TTL ngắn để đổi role/khoá
// tài khoản có hiệu lực gần như ngay lập tức.
const AUTH_CACHE_TTL_MS = 30_000;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly cache = new Map<
    string,
    { value: AuthUser; expiresAt: number }
  >();

  constructor(
    config: ConfigService,
    private prisma: PrismaService,
    private rbac: RbacService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET', 'change-me'),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    const cached = this.cache.get(payload.sub);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: BigInt(payload.sub) },
      include: { locations: true, locationRoles: true },
    });
    if (!user || !user.active || user.status === 'inactive') {
      this.cache.delete(payload.sub);
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
    this.cache.set(payload.sub, {
      value: authUser,
      expiresAt: Date.now() + AUTH_CACHE_TTL_MS,
    });
    return authUser;
  }
}
