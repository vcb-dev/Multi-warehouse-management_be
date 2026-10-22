import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { PERMISSION_CATALOG } from './permission-catalog';

/** Vị trí trong catalog — màn phân quyền hiện nhóm/quyền theo thứ tự này (danh sách → chi tiết → thao tác). */
const CATALOG_ORDER = new Map(PERMISSION_CATALOG.map((p, i) => [p.key, i]));

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
    // Quyền không có trong catalog (vd của nhánh khác còn trong DB) xếp cuối.
    const rank = (key: string) =>
      CATALOG_ORDER.get(key) ?? Number.MAX_SAFE_INTEGER;
    rows.sort((a, b) => rank(a.key) - rank(b.key));
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
