import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private rbac: RbacService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { warehouseRoles: true },
    });
    if (!user || !user.isActive || user.status === 'inactive') {
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
    });

    return {
      access_token: token,
      user: {
        id: user.id.toString(),
        email: user.email,
        name: user.name,
        roles: user.roles,
        warehouse_ids: resolved.warehouseIds.map((w) => w.toString()),
        warehouse_permissions: resolved.warehousePermissions,
        admin_warehouse_ids: resolved.adminWarehouseIds.map((w) => w.toString()),
        permissions: resolved.systemPermissions,
        is_admin: resolved.isAdmin,
      },
    };
  }
}
