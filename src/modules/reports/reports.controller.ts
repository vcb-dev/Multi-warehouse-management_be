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
import {
  DashboardOverviewQueryDto,
  PinReportDto,
  ProductMonthlyOpsQueryDto,
  RunReportQueryDto,
} from './report.dto';
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

  /** Nguồn đơn có thật trong dữ liệu — bộ lọc "Tất cả nguồn đơn" của màn Tổng quan. */
  @Get('order-sources')
  @RequirePermission('report:view')
  orderSources(
    @CurrentUser() user: AuthUser,
    @Query('location_id') locationId?: string,
  ) {
    return this.reports.orderSources(user, locationId);
  }

  /** Màn "Tổng quan" (trang chủ) — không nằm trong khung ReportDef chung. */
  @Get('dashboard')
  @RequirePermission('report:view')
  dashboard(
    @Query() query: DashboardOverviewQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.reports.dashboardOverview(query, user);
  }

  /** Dashboard "Sản phẩm — Vận hành theo tháng" — không nằm trong khung ReportDef chung. */
  @Get('product-monthly-ops')
  @RequirePermission('report:view')
  productMonthlyOps(
    @Query() query: ProductMonthlyOpsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.reports.productMonthlyOps(query, user);
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
