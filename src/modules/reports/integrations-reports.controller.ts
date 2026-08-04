import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/roles.decorator';
import { RequireApiScope } from '../../common/decorators/api-scope.decorator';
import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { ProductMonthlyOpsQueryDto } from './report.dto';
import { ReportService } from './report.service';

/**
 * API cho đối tác bên thứ 3 — xác thực bằng header `x-api-key` (xem `ApiKeyGuard`), KHÔNG
 * qua JWT/đăng nhập. Tách hẳn khỏi `ReportsController` (route JWT nội bộ) để đổi/siết gì ở
 * đây cũng không ảnh hưởng API nội bộ.
 */
@ApiTags('integrations')
@Public()
@UseGuards(ApiKeyGuard, ThrottlerGuard)
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@Controller('integrations/reports')
export class IntegrationsReportsController {
  constructor(private reports: ReportService) {}

  @RequireApiScope('product-monthly-ops')
  @Get('san-pham-van-hanh-theo-thang')
  productMonthlyOps(
    @Query() query: ProductMonthlyOpsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.reports.productMonthlyOps(query, user);
  }
}
