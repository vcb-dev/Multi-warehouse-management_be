import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import { sendXlsx } from '../../common/utils/send-xlsx';
import { PinReportDto, RunReportQueryDto } from './report.dto';
import { ReportService } from './report.service';

@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private reports: ReportService) {}

  /** Thư viện báo cáo, gom theo nhóm. */
  @Get()
  @RequirePermission('report:view')
  catalog() {
    return this.reports.catalog();
  }

  // Khai trước `:id` để route động không nuốt mất `/reports/pinned`.
  @Get('pinned')
  @RequirePermission('report:view')
  pinned(@CurrentUser() user: AuthUser) {
    return this.reports.listPinned(user);
  }

  @Get(':id/export')
  @RequirePermission('report:view')
  async export(
    @Param('id') id: string,
    @Query() query: RunReportQueryDto,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.reports.exportExcel(
      id,
      query,
      user,
    );
    sendXlsx(res, buffer, filename);
  }

  /** Chạy báo cáo — trả kèm metadata cột/chart để frontend dựng bảng động. */
  @Get(':id')
  @RequirePermission('report:view')
  run(
    @Param('id') id: string,
    @Query() query: RunReportQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.reports.run(id, query, user);
  }

  @Post(':id/pin')
  @RequirePermission('report:view')
  pin(
    @Param('id') id: string,
    @Body() dto: PinReportDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.reports.pin(id, dto, user);
  }

  @Delete(':id/pin')
  @RequirePermission('report:view')
  unpin(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.reports.unpin(id, user);
  }
}
