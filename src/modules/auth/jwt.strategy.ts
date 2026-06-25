import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { RbacService } from '../rbac/rbac.service';

type JwtPayload = { sub: string; email: string };

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
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
    const user = await this.prisma.user.findUnique({
      where: { id: BigInt(payload.sub) },
      include: { warehouses: true, warehouseRoles: true },
    });
    if (!user || !user.isActive || user.status === 'inactive') {
      throw new UnauthorizedException();
    }
    const resolved = await this.rbac.resolvePermissions(user.id);
    return {
      userId: user.id,
      email: user.email,
      roles: user.roles,
      warehouseIds: resolved.warehouseIds,
      isAdmin: resolved.isAdmin,
      systemPermissions: resolved.systemPermissions,
      permissions: resolved.systemPermissions,
      warehousePermissions: resolved.warehousePermissions,
    };
  }
}
