import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateRoleDto, UpdateRoleDto } from './rbac.dto';
import { AuthCacheService } from './auth-cache.service';

/** Quyền chỉ được gán cho role hệ thống `admin`. */
export const PROTECTED_PERMISSION_KEYS = new Set([
  'role:manage',
  'staff:manage',
]);

@Injectable()
export class RoleService {
  constructor(
    private prisma: PrismaService,
    private authCache: AuthCacheService,
  ) {}

  async list() {
    const roles = await this.prisma.role.findMany({
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      include: {
        _count: { select: { permissions: true, locationRoles: true } },
      },
    });
    return {
      data: roles.map((r) => ({
        id: r.id.toString(),
        name: r.name,
        code: r.code,
        description: r.description,
        is_system: r.isSystem,
        is_active: r.isActive,
        permission_count: r._count.permissions,
        assigned_count: r._count.locationRoles,
      })),
    };
  }

  async findOne(id: string) {
    const role = await this.prisma.role.findUnique({
      where: { id: BigInt(id) },
      include: { permissions: { include: { permission: true } } },
    });
    if (!role) throw new NotFoundException('ROLE_NOT_FOUND');
    return {
      data: {
        id: role.id.toString(),
        name: role.name,
        code: role.code,
        description: role.description,
        is_system: role.isSystem,
        is_active: role.isActive,
        permissions: role.permissions.map((p) => p.permission.key),
      },
    };
  }

  private assertCustomRolePermissions(keys: string[]) {
    const blocked = keys.filter((k) => PROTECTED_PERMISSION_KEYS.has(k));
    if (blocked.length) {
      throw new ForbiddenException('PROTECTED_PERMISSION');
    }
  }

  private async permissionIdsForKeys(keys: string[]) {
    const perms = await this.prisma.permission.findMany({
      where: { key: { in: keys } },
      select: { id: true, key: true },
    });
    const found = new Set(perms.map((p) => p.key));
    const missing = keys.filter((k) => !found.has(k));
    if (missing.length) {
      throw new BadRequestException(
        `UNKNOWN_PERMISSION: ${missing.join(', ')}`,
      );
    }
    return perms.map((p) => p.id);
  }

  async create(dto: CreateRoleDto) {
    const exists = await this.prisma.role.findUnique({
      where: { code: dto.code },
    });
    if (exists) throw new ConflictException('ROLE_CODE_EXISTS');

    if (dto.permission_keys?.length) {
      this.assertCustomRolePermissions(dto.permission_keys);
    }

    const permIds = dto.permission_keys?.length
      ? await this.permissionIdsForKeys(dto.permission_keys)
      : [];

    const role = await this.prisma.role.create({
      data: {
        name: dto.name,
        code: dto.code,
        description: dto.description,
        permissions: {
          create: permIds.map((permissionId) => ({ permissionId })),
        },
      },
    });
    return this.findOne(role.id.toString());
  }

  async update(id: string, dto: UpdateRoleDto) {
    const role = await this.prisma.role.findUnique({
      where: { id: BigInt(id) },
    });
    if (!role) throw new NotFoundException('ROLE_NOT_FOUND');
    if (role.isSystem) {
      if (dto.is_active === false || dto.permission_keys !== undefined) {
        throw new ForbiddenException('ROLE_SYSTEM');
      }
    } else if (dto.permission_keys?.length) {
      this.assertCustomRolePermissions(dto.permission_keys);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.role.update({
        where: { id: role.id },
        data: {
          name: dto.name ?? role.name,
          description: dto.description ?? role.description,
          isActive: dto.is_active ?? role.isActive,
        },
      });
      if (dto.permission_keys && !role.isSystem) {
        const permIds = dto.permission_keys.length
          ? await this.permissionIdsForKeys(dto.permission_keys)
          : [];
        await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
        if (permIds.length) {
          await tx.rolePermission.createMany({
            data: permIds.map((permissionId) => ({
              roleId: role.id,
              permissionId,
            })),
            skipDuplicates: true,
          });
        }
      }
    });

    // Đổi tập quyền hoặc khoá/mở role ảnh hưởng MỌI user đang mang role này —
    // không biết cụ thể ai nên invalidate cả loạt thay vì đoán.
    if (dto.permission_keys !== undefined || dto.is_active !== undefined) {
      await this.invalidateUsersWithRole(role.id);
    }
    return this.findOne(id);
  }

  private async invalidateUsersWithRole(roleId: bigint) {
    const holders = await this.prisma.userLocationRole.findMany({
      where: { roleId },
      select: { userId: true },
      distinct: ['userId'],
    });
    for (const h of holders) this.authCache.invalidate(h.userId);
  }

  async remove(id: string) {
    const role = await this.prisma.role.findUnique({
      where: { id: BigInt(id) },
      include: { _count: { select: { locationRoles: true } } },
    });
    if (!role) throw new NotFoundException('ROLE_NOT_FOUND');
    if (role.isSystem) throw new ForbiddenException('ROLE_SYSTEM');
    if (role._count.locationRoles > 0)
      throw new ConflictException('ROLE_IN_USE');
    await this.prisma.role.delete({ where: { id: role.id } });
  }
}
