import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ListUsersQueryDto, PutWarehouseRolesDto } from './rbac.dto';

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
    if (query.status && ['invited', 'active', 'inactive'].includes(query.status)) {
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
    const user = await this.prisma.user.findUnique({ where: { id: BigInt(id) } });
    if (!user) throw new NotFoundException('USER_NOT_FOUND');
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        isActive,
        status: isActive ? (user.passwordHash ? 'active' : 'invited') : 'inactive',
      },
    });
    return this.findOne(id);
  }

  async putWarehouseRoles(id: string, dto: PutWarehouseRolesDto) {
    const user = await this.prisma.user.findUnique({ where: { id: BigInt(id) } });
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
}
