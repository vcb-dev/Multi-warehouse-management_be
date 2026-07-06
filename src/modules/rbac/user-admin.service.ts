import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ListUsersQueryDto,
  PutWarehouseRolesDto,
  UpdateUserPermissionsDto,
} from './rbac.dto';
import { PROTECTED_PERMISSION_KEYS } from './role.service';

@Injectable()
export class UserAdminService {
  constructor(private prisma: PrismaService) {}

  async listAssignable(search?: string) {
    const where: Prisma.UserWhereInput = {
      status: 'active',
      isActive: true,
    };
    if (search?.trim()) {
      where.OR = [
        { name: { contains: search.trim(), mode: 'insensitive' } },
        { email: { contains: search.trim(), mode: 'insensitive' } },
      ];
    }

    const rows = await this.prisma.user.findMany({
      where,
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
      take: 500,
      select: { id: true, name: true, email: true },
    });

    return {
      data: rows.map((u) => ({
        id: u.id.toString(),
        name: u.name?.trim() || u.email,
      })),
    };
  }

  async list(query: ListUsersQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.UserWhereInput = {};
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (
      query.status &&
      ['invited', 'active', 'inactive'].includes(query.status)
    ) {
      where.status = query.status as Prisma.EnumAccountStatusFilter['equals'];
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { _count: { select: { warehouseRoles: true } } },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data: rows.map((u) => ({
        id: u.id.toString(),
        name: u.name,
        email: u.email,
        phone: u.phone,
        status: u.status,
        roles: u.roles,
        warehouse_role_count: u._count.warehouseRoles,
      })),
      meta: { page, limit, total, total_pages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: BigInt(id) },
      include: {
        warehouseRoles: {
          include: {
            warehouse: true,
            role: { include: { _count: { select: { permissions: true } } } },
          },
        },
      },
    });
    if (!user) throw new NotFoundException('USER_NOT_FOUND');
    return {
      data: {
        id: user.id.toString(),
        name: user.name,
        email: user.email,
        phone: user.phone,
        status: user.status,
        warehouse_roles: user.warehouseRoles.map((wr) => ({
          warehouse_id: wr.warehouseId.toString(),
          warehouse_name: wr.warehouse.name,
          role_id: wr.roleId.toString(),
          role_name: wr.role.name,
          permission_count: wr.role._count.permissions,
        })),
      },
    };
  }

  async setStatus(id: string, isActive: boolean) {
    const user = await this.prisma.user.findUnique({
      where: { id: BigInt(id) },
    });
    if (!user) throw new NotFoundException('USER_NOT_FOUND');
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        isActive,
        status: isActive
          ? user.passwordHash
            ? 'active'
            : 'invited'
          : 'inactive',
      },
    });
    return this.findOne(id);
  }

  async putWarehouseRoles(id: string, dto: PutWarehouseRolesDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: BigInt(id) },
    });
    if (!user) throw new NotFoundException('USER_NOT_FOUND');

    const seen = new Set<string>();
    for (const a of dto.assignments) {
      if (seen.has(a.warehouse_id)) {
        throw new BadRequestException('DUPLICATE_WAREHOUSE');
      }
      seen.add(a.warehouse_id);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.userWarehouseRole.deleteMany({ where: { userId: user.id } });
      if (dto.assignments.length) {
        await tx.userWarehouseRole.createMany({
          data: dto.assignments.map((a) => ({
            userId: user.id,
            warehouseId: BigInt(a.warehouse_id),
            roleId: BigInt(a.role_id),
          })),
        });
      }
    });
    return this.findOne(id);
  }

  async removeWarehouseRole(id: string, warehouseId: string) {
    await this.prisma.userWarehouseRole.deleteMany({
      where: { userId: BigInt(id), warehouseId: BigInt(warehouseId) },
    });
  }

  private async getWarehouseRoleAssignment(id: string, warehouseId: string) {
    const assignment = await this.prisma.userWarehouseRole.findUnique({
      where: {
        userId_warehouseId: {
          userId: BigInt(id),
          warehouseId: BigInt(warehouseId),
        },
      },
      include: {
        role: { include: { permissions: { include: { permission: true } } } },
      },
    });
    if (!assignment) throw new NotFoundException('WAREHOUSE_ROLE_NOT_FOUND');
    return assignment;
  }

  /** Quyền hiệu lực = quyền mặc định của role tại kho, chồng lệch (override) riêng của user. */
  async getWarehousePermissions(id: string, warehouseId: string) {
    const assignment = await this.getWarehouseRoleAssignment(id, warehouseId);
    const overrides = await this.prisma.userPermissionOverride.findMany({
      where: { userId: BigInt(id), warehouseId: BigInt(warehouseId) },
      include: { permission: true },
    });

    const rolePermissionKeys = assignment.role.permissions.map(
      (p) => p.permission.key,
    );
    const effective = new Set(rolePermissionKeys);
    for (const o of overrides) {
      if (o.granted) effective.add(o.permission.key);
      else effective.delete(o.permission.key);
    }

    return {
      data: {
        role_id: assignment.roleId.toString(),
        role_name: assignment.role.name,
        is_system: assignment.role.isSystem,
        role_permission_keys: rolePermissionKeys,
        permission_keys: [...effective],
      },
    };
  }

  /** Lưu lệch quyền (chỉ diff so với mặc định của role) cho user tại một kho. */
  async updateWarehousePermissions(
    id: string,
    warehouseId: string,
    dto: UpdateUserPermissionsDto,
  ) {
    const assignment = await this.getWarehouseRoleAssignment(id, warehouseId);
    if (assignment.role.isSystem) throw new ForbiddenException('ROLE_SYSTEM');

    const allPermissions = await this.prisma.permission.findMany({
      select: { id: true, key: true },
    });
    const idByKey = new Map(allPermissions.map((p) => [p.key, p.id]));
    const unknown = dto.permission_keys.filter((k) => !idByKey.has(k));
    if (unknown.length) {
      throw new BadRequestException(
        `UNKNOWN_PERMISSION: ${unknown.join(', ')}`,
      );
    }

    const roleDefaultKeys = new Set(
      assignment.role.permissions.map((p) => p.permission.key),
    );
    const desiredKeys = new Set(dto.permission_keys);
    const toGrant = [...desiredKeys].filter((k) => !roleDefaultKeys.has(k));
    const toRevoke = [...roleDefaultKeys].filter((k) => !desiredKeys.has(k));

    if (toGrant.some((k) => PROTECTED_PERMISSION_KEYS.has(k))) {
      throw new ForbiddenException('PROTECTED_PERMISSION');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.userPermissionOverride.deleteMany({
        where: {
          userId: assignment.userId,
          warehouseId: assignment.warehouseId,
        },
      });
      const rows = [
        ...toGrant.map((key) => ({
          permissionId: idByKey.get(key)!,
          granted: true,
        })),
        ...toRevoke.map((key) => ({
          permissionId: idByKey.get(key)!,
          granted: false,
        })),
      ];
      if (rows.length) {
        await tx.userPermissionOverride.createMany({
          data: rows.map((r) => ({
            userId: assignment.userId,
            warehouseId: assignment.warehouseId,
            permissionId: r.permissionId,
            granted: r.granted,
          })),
        });
      }
    });

    return this.getWarehousePermissions(id, warehouseId);
  }
}
