import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { CostVisibilityInterceptor } from '../../common/interceptors/cost-visibility.interceptor';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import { ActivityLogService } from '../activity-log/activity-log.service';
import {
  CreateStockTransferDto,
  ListStockTransfersQueryDto,
  StnTransitionDto,
  UpdateStockTransferDto,
} from './stock-transfer.dto';
import { StockTransferService } from './stock-transfer.service';

@ApiTags('stock-transfers')
@ApiBearerAuth()
@UseInterceptors(CostVisibilityInterceptor)
@Controller('stock-transfers')
export class StockTransferController {
  constructor(
    private transfers: StockTransferService,
    private activityLog: ActivityLogService,
  ) {}

  @Get()
  @RequirePermission('stock_transfer:view')
  list(
    @Query() query: ListStockTransfersQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.transfers.list(query, user);
  }

  @Post()
  @RequirePermission('stock_transfer:manage')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateStockTransferDto, @CurrentUser() user: AuthUser) {
    return this.transfers.create(dto, user);
  }

  @Get(':id')
  @RequirePermission('stock_transfer:view_detail')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.transfers.findOne(BigInt(id), user);
  }

  @Put(':id')
  @RequirePermission('stock_transfer:manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateStockTransferDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.transfers.update(BigInt(id), dto, user);
  }

  @Post(':id/transition')
  @RequirePermission('stock_transfer:manage')
  transition(
    @Param('id') id: string,
    @Body() dto: StnTransitionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.transfers.transition(BigInt(id), dto.action, user);
  }

  @Post(':id/receive')
  @RequirePermission('stock_transfer:receive')
  receive(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.transfers.receive(BigInt(id), user);
  }

  @Post(':id/cancel')
  @RequirePermission('stock_transfer:manage')
  cancel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.transfers.cancel(BigInt(id), user);
  }

  @Get(':id/history')
  @RequirePermission('stock_transfer:view_detail')
  async getHistory(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.transfers.assertTransferReadable(BigInt(id), user);
    return this.activityLog.getHistory('stock_transfer', BigInt(id));
  }
}
