import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import { ParseBigIntPipe } from '../../common/pipes/parse-bigint.pipe';
import { ActivityLogService } from '../activity-log/activity-log.service';
import {
  CreateOrderDto,
  ExportOrdersQueryDto,
  ListOrdersQueryDto,
  OrderTransitionDto,
  PayOrderDto,
  UpdateOrderDto,
} from './order.dto';
import { OrderExportService } from './order-export.service';
import { OrderService } from './order.service';

@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(
    private orders: OrderService,
    private exporter: OrderExportService,
    private activityLog: ActivityLogService,
  ) {}

  @Get()
  @RequirePermission('order:view')
  list(@Query() query: ListOrdersQueryDto, @CurrentUser() user: AuthUser) {
    return this.orders.list(query, user);
  }

  @Post()
  @RequirePermission('order:create')
  create(@Body() dto: CreateOrderDto, @CurrentUser() user: AuthUser) {
    return this.orders.create(dto, user);
  }

  // Hai route 'export*' phải đứng trước @Get(':id'), nếu không Nest sẽ khớp
  // 'export' thành id và trả 404.
  @Get('export/fields')
  @RequirePermission('order:view')
  exportFields(@Query() query: ExportOrdersQueryDto) {
    return this.exporter.fields(query.mode ?? 'order');
  }

  @Get('export')
  @RequirePermission('order:view')
  async export(
    @Query() query: ExportOrdersQueryDto,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    await this.exporter.export(query, user, res);
  }

  @Get(':id')
  @RequirePermission('order:view')
  findOne(
    @Param('id', ParseBigIntPipe) id: bigint,
    @CurrentUser() user: AuthUser,
  ) {
    return this.orders.findOne(id, user);
  }

  @Get(':id/history')
  @RequirePermission('order:view')
  async history(
    @Param('id', ParseBigIntPipe) id: bigint,
    @CurrentUser() user: AuthUser,
  ) {
    await this.orders.assertOrderPermission(id, user, 'order:view');
    return this.activityLog.getHistory('order', id);
  }

  @Put(':id')
  @RequirePermission('order:update')
  update(
    @Param('id', ParseBigIntPipe) id: bigint,
    @Body() dto: UpdateOrderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.orders.update(id, dto, user);
  }

  @Post(':id/transition')
  @RequirePermission('order:update', 'order:cancel', 'order:pack')
  transition(
    @Param('id', ParseBigIntPipe) id: bigint,
    @Body() dto: OrderTransitionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.orders.transition(id, dto, user);
  }

  @Post(':id/payments')
  @RequirePermission('order:update')
  pay(
    @Param('id', ParseBigIntPipe) id: bigint,
    @Body() dto: PayOrderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.orders.pay(id, dto, user);
  }
}
