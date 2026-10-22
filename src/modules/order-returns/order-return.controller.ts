import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import {
  CreateOrderReturnDto,
  ListOrderReturnsQueryDto,
  ListReturnDocumentsQueryDto,
  ReceiveOrderReturnDto,
  RefundOrderReturnDto,
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
  @RequirePermission('order_return:create')
  create(@Body() dto: CreateOrderReturnDto, @CurrentUser() user: AuthUser) {
    return this.returns.create(dto, user);
  }

  // --- Phiếu trả hàng theo quy trình: tạo → nhận hàng → hoàn tiền → hoàn thành ---

  @Get('documents')
  @RequirePermission('order_return:view')
  listDocuments(
    @Query() query: ListReturnDocumentsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.returns.listDocuments(query, user);
  }

  @Get('documents/:id')
  @RequirePermission('order_return:view_detail')
  findDocument(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.returns.findDocument(BigInt(id), user);
  }

  @Post(':id/receive')
  @HttpCode(200)
  @RequirePermission('order_return:process')
  receive(
    @Param('id') id: string,
    @Body() dto: ReceiveOrderReturnDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.returns.receive(BigInt(id), dto, user);
  }

  @Post(':id/refund')
  @HttpCode(200)
  @RequirePermission('order_return:process')
  refund(
    @Param('id') id: string,
    @Body() dto: RefundOrderReturnDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.returns.refund(BigInt(id), dto, user);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('order_return:cancel')
  cancel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.returns.cancel(BigInt(id), user);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @RequirePermission('order_return:process')
  complete(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.returns.complete(BigInt(id), user);
  }
}
