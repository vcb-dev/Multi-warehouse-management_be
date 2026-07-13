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
} from '@nestjs/common';
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
@Controller('stock-transfers')
export class StockTransferController {
  constructor(
    private transfers: StockTransferService,
    private activityLog: ActivityLogService,
  ) {}

  @Get()
  @RequirePermission('inventory:transfer', 'inventory:view')
  list(
    @Query() query: ListStockTransfersQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.transfers.list(query, user);
  }

  @Post()
  @RequirePermission('inventory:transfer')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateStockTransferDto, @CurrentUser() user: AuthUser) {
    return this.transfers.create(dto, user);
  }

  @Get(':id')
  @RequirePermission('inventory:transfer', 'inventory:view')
  findOne(@Param('id') id: string) {
    return this.transfers.findOne(BigInt(id));
  }

  @Put(':id')
  @RequirePermission('inventory:transfer')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateStockTransferDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.transfers.update(BigInt(id), dto, user);
  }

  @Post(':id/transition')
  @RequirePermission('inventory:transfer')
  transition(
    @Param('id') id: string,
    @Body() dto: StnTransitionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.transfers.transition(BigInt(id), dto.action, user);
  }

  @Post(':id/receive')
  @RequirePermission('inventory:transfer')
  receive(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.transfers.receive(BigInt(id), user);
  }

  @Post(':id/cancel')
  @RequirePermission('inventory:transfer')
  cancel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.transfers.cancel(BigInt(id), user);
  }

  @Get(':id/history')
  @RequirePermission('inventory:transfer', 'inventory:view')
  getHistory(@Param('id') id: string) {
    return this.activityLog.getHistory('stock_transfer', BigInt(id));
  }
}
