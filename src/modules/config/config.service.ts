import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { hasPermission } from '../../common/auth/access';

@Injectable()
export class ConfigService {
  constructor(private prisma: PrismaService) {}

  async listBranches(user: AuthUser) {
    const canSeeAll = hasPermission(user, 'staff:manage');

    const data = await this.prisma.branch.findMany({
      where: {
        isActive: true,
        ...(canSeeAll
          ? {}
          : { warehouses: { some: { id: { in: user.warehouseIds } } } }),
      },
      orderBy: { code: 'asc' },
    });
    return {
      data: data.map((b) => ({
        id: b.id.toString(),
        code: b.code,
        name: b.name,
        is_active: b.isActive,
      })),
    };
  }

  async listWarehouses(user: AuthUser, branchId?: bigint) {
    const canSeeAll = hasPermission(user, 'staff:manage');

    const data = await this.prisma.warehouse.findMany({
      where: {
        isActive: true,
        ...(branchId ? { branchId } : {}),
        ...(canSeeAll ? {} : { id: { in: user.warehouseIds } }),
      },
      orderBy: { code: 'asc' },
    });
    return {
      data: data.map((w) => ({
        id: w.id.toString(),
        code: w.code,
        name: w.name,
        branch_id: w.branchId.toString(),
        is_active: w.isActive,
      })),
    };
  }
}
