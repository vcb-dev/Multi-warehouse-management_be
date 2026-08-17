import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import {
  CreateOrderReturnDto,
  ListOrderReturnsQueryDto,
} from '../orders/order.dto';
import { OrderReturnService } from './order-return.service';

@ApiTags('order-returns')
@ApiBearerAuth()
@Controller('order-returns')
export class OrderReturnController {
  constructor(private returns: OrderReturnService) {}

  @Get()
  @RequirePermission('order_return:view')
  list(
    @Query() query: ListOrderReturnsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.returns.list(query, user);
  }

  @Post()
  @RequirePermission('order_return:manage')
  create(@Body() dto: CreateOrderReturnDto, @CurrentUser() user: AuthUser) {
    return this.returns.create(dto, user);
  }
}
