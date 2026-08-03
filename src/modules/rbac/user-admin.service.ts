import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PermissionScope, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { userDisplayName } from '../../common/utils/user-display-name';
import { isAdminUser } from '../../common/auth/access';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import {
  ListUsersQueryDto,
  PutWarehouseRolesDto,
  UpdateUserPermissionsDto,
} from './rbac.dto';
import { PROTECTED_PERMISSION_KEYS } from './role.service';
import { AuthCacheService } from './auth-cache.service';

/** Điều kiện nhận diện role admin hệ thống — chỉ role này bypass toàn cục. */
const isSystemAdminRole = (role: { isSystem: boolean; code: string }) =>
  role.isSystem && role.code === 'admin';

@Injectable()
export class UserAdminService {
  constructor(
    private prisma: PrismaService,
    private authCache: AuthCacheService,
  ) {}

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

  /**
   * true nếu user đang có role admin (bất kỳ kho nào), tức có `staff:manage`
   * toàn cục. Dùng để biết một thao tác có đang đụng vào quyền admin không.
   */
  private async isCurrentlyAdmin(userId: bigint): Promise<boolean> {
    const count = await this.prisma.userLocationRole.count({
      where: {
        userId,
        role: { isSystem: true, code: 'admin', isActive: true },
      },
    });
    return count > 0;
  }

  /**
   * true nếu tồn tại admin ACTIVE khác ngoài `excludeUserId` — "active" nghĩa
   * là còn đăng nhập được (không thì họ không cứu được hệ thống khi cần).
   */
  private async hasOtherActiveAdmin(excludeUserId: bigint): Promise<boolean> {
    const count = await this.prisma.userLocationRole.count({
      where: {
        userId: { not: excludeUserId },
        role: { isSystem: true, code: 'admin', isActive: true },
        user: { active: true, status: { not: 'inactive' } },
      },
    });
    return count > 0;
  }

  /**
   * Chặn thao tác khiến hệ thống còn 0 admin — mất luôn `staff:manage` nên
   * không ai tự cứu lại được nếu không sửa DB trực tiếp.
   */
  private async assertKeepsAtLeastOneAdmin(
    userId: bigint,
    willRemainAdmin: boolean,
  ) {
    if (willRemainAdmin) return;
    if (!(await this.isCurrentlyAdmin(userId))) return;
    if (await this.hasOtherActiveAdmin(userId)) return;
    throw new ConflictException(
      'LAST_ADMIN: Không thể thực hiện — đây là quản trị viên cuối cùng của hệ thống.',
    );
  }

  async setStatus(id: string, isActive: boolean) {
    const user = await this.prisma.user.findUnique({
      where: { id: BigInt(id) },
    });
    if (!user) throw new NotFoundException('USER_NOT_FOUND');
    if (!isActive) {
      await this.assertKeepsAtLeastOneAdmin(user.id, false);
    }
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
    // Khoá tài khoản phải chặn được request kế tiếp ngay, không đợi hết TTL.
    this.authCache.invalidate(user.id);
    return this.findOne(id);
  }

  async putWarehouseRoles(
    id: string,
    dto: PutWarehouseRolesDto,
    caller: AuthUser,
  ) {
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

    const roleIds = [...new Set(dto.assignments.map((a) => a.role_id))].map(
      (roleId) => BigInt(roleId),
    );
    const roles = await this.prisma.role.findMany({
      where: { id: { in: roleIds } },
      select: { id: true, code: true, isSystem: true },
    });
    const roleById = new Map(roles.map((r) => [r.id.toString(), r]));
    const unknownRoles = dto.assignments.filter(
      (a) => !roleById.has(a.role_id),
    );
    if (unknownRoles.length) {
      throw new BadRequestException('ROLE_NOT_FOUND');
    }

    const willRemainAdmin = dto.assignments.some((a) =>
      isSystemAdminRole(roleById.get(a.role_id)!),
    );

    // Chỉ admin mới được cấp thêm admin — dù hiện chỉ admin (staff:manage) mới
    // gọi được endpoint này, kiểm lại ở đây để không phụ thuộc riêng vào guard.
    if (willRemainAdmin && !isAdminUser(caller)) {
      throw new ForbiddenException('ADMIN_ROLE_REQUIRES_ADMIN');
    }
    await this.assertKeepsAtLeastOneAdmin(user.id, willRemainAdmin);

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
    this.authCache.invalidate(user.id);
    return this.findOne(id);
  }

  async removeWarehouseRole(id: string, locationId: string) {
    const userId = BigInt(id);
    const removing = await this.prisma.userLocationRole.findUnique({
      where: { userId_locationId: { userId, locationId: BigInt(locationId) } },
      include: { role: { select: { code: true, isSystem: true } } },
    });
    if (removing && isSystemAdminRole(removing.role)) {
      const staysAdminElsewhere = await this.prisma.userLocationRole.count({
        where: {
          userId,
          locationId: { not: BigInt(locationId) },
          role: { isSystem: true, code: 'admin', isActive: true },
        },
      });
      await this.assertKeepsAtLeastOneAdmin(userId, staysAdminElsewhere > 0);
    }
    await this.prisma.userLocationRole.deleteMany({
      where: { userId, locationId: BigInt(locationId) },
    });
    this.authCache.invalidate(userId);
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
      select: { id: true, key: true, scope: true },
    });
    const idByKey = new Map(allPermissions.map((p) => [p.key, p.id]));
    const systemScopedKeys = new Set(
      allPermissions
        .filter((p) => p.scope === PermissionScope.system)
        .map((p) => p.key),
    );
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

    // Quyền scope=system hiệu lực toàn hệ thống nên không thể lệch theo từng kho.
    // Chặn ở đây thay vì để lưu xong rồi bị bỏ qua lúc resolve (im lặng khó hiểu).
    const systemScopedChanges = [...toGrant, ...toRevoke].filter((k) =>
      systemScopedKeys.has(k),
    );
    if (systemScopedChanges.length) {
      throw new BadRequestException(
        `SYSTEM_SCOPED_PERMISSION: ${systemScopedChanges.join(', ')} là quyền toàn hệ thống, không lệch được theo kho`,
      );
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

    this.authCache.invalidate(assignment.userId);
    return this.getWarehousePermissions(id, locationId);
  }
}
