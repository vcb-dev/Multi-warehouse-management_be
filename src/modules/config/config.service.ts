import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ConfigService {
  constructor(private prisma: PrismaService) {}

  async listBranches() {
    const data = await this.prisma.branch.findMany({
      where: { isActive: true },
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

  async listWarehouses(branchId?: bigint) {
    const data = await this.prisma.warehouse.findMany({
      where: {
        isActive: true,
        ...(branchId ? { branchId } : {}),
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
