import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import {
  CreateOrderDto,
  ListOrdersQueryDto,
  OrderTransitionDto,
  UpdateOrderDto,
} from './order.dto';
import { OrderService } from './order.service';

@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(private orders: OrderService) {}

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

  @Get(':id')
  @RequirePermission('order:view')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.orders.findOne(BigInt(id), user);
  }

  @Put(':id')
  @RequirePermission('order:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateOrderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.orders.update(BigInt(id), dto, user);
  }

  @Post(':id/transition')
  @RequirePermission('order:update', 'order:cancel', 'order:pack')
  transition(
    @Param('id') id: string,
    @Body() dto: OrderTransitionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.orders.transition(BigInt(id), dto, user);
  }
}
