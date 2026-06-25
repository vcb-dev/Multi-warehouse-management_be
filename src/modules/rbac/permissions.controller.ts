import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('rbac')
@ApiBearerAuth()
@Controller('permissions')
export class PermissionsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  @RequirePermission('role:manage', 'staff:manage')
  async list() {
    const rows = await this.prisma.permission.findMany({
      orderBy: [{ group: 'asc' }, { label: 'asc' }],
    });
    return {
      data: rows.map((p) => ({
        key: p.key,
        group: p.group,
        label: p.label,
        scope: p.scope,
      })),
    };
  }
}
