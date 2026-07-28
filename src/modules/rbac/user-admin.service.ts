import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { userDisplayName } from '../../common/utils/user-display-name';
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
      active: true,
    };
    if (search?.trim()) {
      where.OR = [
        { firstName: { contains: search.trim(), mode: 'insensitive' } },
        { lastName: { contains: search.trim(), mode: 'insensitive' } },
        { email: { contains: search.trim(), mode: 'insensitive' } },
      ];
    }

    const rows = await this.prisma.user.findMany({
      where,
      orderBy: [{ firstName: 'asc' }, { email: 'asc' }],
      take: 500,
      select: { id: true, firstName: true, lastName: true, email: true },
    });

    return {
      data: rows.map((u) => ({
        id: u.id.toString(),
        name: userDisplayName(u) || u.email,
      })),
    };
  }

  async list(query: ListUsersQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.UserWhereInput = {};
    if (query.search) {
      where.OR = [
        { firstName: { contains: query.search, mode: 'insensitive' } },
        { lastName: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
        { phoneNumber: { contains: query.search, mode: 'insensitive' } },
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
        orderBy: { createdOn: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { _count: { select: { locationRoles: true } } },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data: rows.map((u) => ({
        id: u.id.toString(),
        name: userDisplayName(u),
        email: u.email,
        phone_number: u.phoneNumber,
        status: u.status,
        roles: u.roles,
        warehouse_role_count: u._count.locationRoles,
      })),
      meta: { page, limit, total, total_pages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: BigInt(id) },
      include: {
        locationRoles: {
          include: {
            location: true,
            role: { include: { _count: { select: { permissions: true } } } },
          },
        },
      },
    });
    if (!user) throw new NotFoundException('USER_NOT_FOUND');
    return {
      data: {
        id: user.id.toString(),
        name: userDisplayName(user),
        email: user.email,
        phone_number: user.phoneNumber,
        status: user.status,
        warehouse_roles: user.locationRoles.map((wr) => ({
          location_id: wr.locationId.toString(),
          location_name: wr.location.name,
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
        active: isActive,
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
      if (seen.has(a.location_id)) {
        throw new BadRequestException('DUPLICATE_WAREHOUSE');
      }
      seen.add(a.location_id);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.userLocationRole.deleteMany({ where: { userId: user.id } });
      if (dto.assignments.length) {
        await tx.userLocationRole.createMany({
          data: dto.assignments.map((a) => ({
            userId: user.id,
            locationId: BigInt(a.location_id),
            roleId: BigInt(a.role_id),
          })),
        });
      }
    });
    return this.findOne(id);
  }

  async removeWarehouseRole(id: string, locationId: string) {
    await this.prisma.userLocationRole.deleteMany({
      where: { userId: BigInt(id), locationId: BigInt(locationId) },
    });
  }

  private async getWarehouseRoleAssignment(id: string, locationId: string) {
    const assignment = await this.prisma.userLocationRole.findUnique({
      where: {
        userId_locationId: {
          userId: BigInt(id),
          locationId: BigInt(locationId),
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
  async getWarehousePermissions(id: string, locationId: string) {
    const assignment = await this.getWarehouseRoleAssignment(id, locationId);
    const overrides = await this.prisma.userPermissionOverride.findMany({
      where: { userId: BigInt(id), locationId: BigInt(locationId) },
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
    locationId: string,
    dto: UpdateUserPermissionsDto,
  ) {
    const assignment = await this.getWarehouseRoleAssignment(id, locationId);
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
          locationId: assignment.locationId,
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
            locationId: assignment.locationId,
            permissionId: r.permissionId,
            granted: r.granted,
          })),
        });
      }
    });

    return this.getWarehousePermissions(id, locationId);
  }
}
