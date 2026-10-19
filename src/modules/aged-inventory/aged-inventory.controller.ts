import { Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import {
  LocationOptional,
  RequirePermission,
} from '../../common/decorators/permissions.decorator';
import { AgedInventoryQueryService } from './aged-inventory-query.service';
import { AgedInventorySnapshotService } from './aged-inventory-snapshot.service';
import { ListAgedInventoryQueryDto } from './aged-inventory.dto';

/**
 * Trang sức tồn lâu — đọc từ snapshot dựng bằng `POST aged-inventory/refresh` (cron 0h đã gỡ
 * 19/10/2026, không còn lượt tự chạy).
 * Hệ thống ngoài gọi bằng header `x-api-key`; quyền của key là quyền của user mà key
 * đứng tên, nên user đó cần `inventory:view`.
 */
@ApiTags('aged-inventory')
@ApiBearerAuth()
@ApiSecurity('x-api-key')
@Controller('aged-inventory')
export class AgedInventoryController {
  constructor(
    private readonly query: AgedInventoryQueryService,
    private readonly snapshots: AgedInventorySnapshotService,
  ) {}

  @Get()
  @RequirePermission('inventory:view')
  list(
    @Query() query: ListAgedInventoryQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.query.list(query, user);
  }

  /** Dựng lại snapshot hôm nay — cách duy nhất để có snapshot mới, chạy nền ~10 phút. */
  @Post('refresh')
  @RequirePermission('role:manage')
  @LocationOptional()
  refresh() {
    return this.snapshots.startInBackground();
  }
}
