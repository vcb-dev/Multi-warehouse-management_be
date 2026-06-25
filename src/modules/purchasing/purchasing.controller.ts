import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import { GoodsReceiptService } from './goods-receipt.service';
import { PurchaseOrderService } from './purchase-order.service';
import { PurchaseReturnService } from './purchase-return.service';
import {
  CreateGoodsReceiptDto,
  CreatePurchaseOrderDto,
  CreatePurchaseReturnDto,
  ListGoodsReceiptsQueryDto,
  ListPurchaseOrdersQueryDto,
  ListPurchaseReturnsQueryDto,
  PoTransitionDto,
} from './purchasing.dto';

@ApiTags('purchasing')
@ApiBearerAuth()
@Controller()
export class PurchasingController {
  constructor(
    private po: PurchaseOrderService,
    private rei: GoodsReceiptService,
    private pvn: PurchaseReturnService,
  ) {}

  @Get('purchase-orders')
  @RequirePermission('purchasing:manage', 'inventory:view')
  listPo(@Query() query: ListPurchaseOrdersQueryDto) {
    return this.po.list(query);
  }

  @Post('purchase-orders')
  @RequirePermission('purchasing:manage')
  @HttpCode(HttpStatus.CREATED)
  createPo(@Body() dto: CreatePurchaseOrderDto, @CurrentUser() user: AuthUser) {
    return this.po.create(dto, user);
  }

  @Get('purchase-orders/:id')
  @RequirePermission('purchasing:manage', 'inventory:view')
  getPo(@Param('id') id: string) {
    return this.po.findOne(BigInt(id));
  }

  @Post('purchase-orders/:id/transition')
  @RequirePermission('purchasing:manage')
  transitionPo(
    @Param('id') id: string,
    @Body() dto: PoTransitionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.po.transition(BigInt(id), dto.action, user);
  }

  @Get('goods-receipts')
  @RequirePermission('purchasing:manage', 'inventory:view', 'inventory:receive')
  listRei(@Query() query: ListGoodsReceiptsQueryDto) {
    return this.rei.list(query);
  }

  @Post('goods-receipts')
  @RequirePermission('inventory:receive', 'purchasing:manage')
  @HttpCode(HttpStatus.CREATED)
  createRei(
    @Body() dto: CreateGoodsReceiptDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.rei.create(dto, user);
  }

  @Get('goods-receipts/:id')
  @RequirePermission('purchasing:manage', 'inventory:view', 'inventory:receive')
  getRei(@Param('id') id: string) {
    return this.rei.findOne(BigInt(id));
  }

  @Post('goods-receipts/:id/confirm')
  @RequirePermission('inventory:receive', 'purchasing:manage')
  confirmRei(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.rei.confirm(BigInt(id), user);
  }

  @Post('goods-receipts/:id/pay')
  @RequirePermission('purchasing:manage')
  payRei(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.rei.pay(BigInt(id), user);
  }

  @Get('purchase-returns')
  @RequirePermission('purchasing:manage', 'inventory:view')
  listPvn(@Query() query: ListPurchaseReturnsQueryDto) {
    return this.pvn.list(query);
  }

  @Post('purchase-returns')
  @RequirePermission('purchasing:manage', 'inventory:receive')
  @HttpCode(HttpStatus.CREATED)
  createPvn(
    @Body() dto: CreatePurchaseReturnDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.pvn.create(dto, user);
  }
}
