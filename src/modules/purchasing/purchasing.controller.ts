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
  PayGoodsReceiptDto,
  PoTransitionDto,
  UpdatePurchaseOrderDto,
} from './purchasing.dto';

@ApiTags('purchasing')
@ApiBearerAuth()
@Controller()
export class PurchasingController {
  constructor(
    private po: PurchaseOrderService,
    private rei: GoodsReceiptService,
    private pvn: PurchaseReturnService,
    private activityLog: ActivityLogService,
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

  @Put('purchase-orders/:id')
  @RequirePermission('purchasing:manage')
  updatePo(
    @Param('id') id: string,
    @Body() dto: UpdatePurchaseOrderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.po.update(BigInt(id), dto, user);
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

  @Get('purchase-orders/:id/history')
  @RequirePermission('purchasing:manage', 'inventory:view')
  getPoHistory(@Param('id') id: string) {
    return this.activityLog.getHistory('purchase_order', BigInt(id));
  }

  @Get('goods-receipts')
  @RequirePermission('purchasing:manage', 'inventory:view', 'inventory:receive')
  listRei(@Query() query: ListGoodsReceiptsQueryDto) {
    return this.rei.list(query);
  }

  @Post('goods-receipts')
  @RequirePermission('inventory:receive', 'purchasing:manage')
  @HttpCode(HttpStatus.CREATED)
  createRei(@Body() dto: CreateGoodsReceiptDto, @CurrentUser() user: AuthUser) {
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
  payRei(
    @Param('id') id: string,
    @Body() dto: PayGoodsReceiptDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.rei.pay(BigInt(id), user, dto.amount);
  }

  @Post('goods-receipts/:id/cancel')
  @RequirePermission('inventory:receive', 'purchasing:manage')
  cancelRei(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.rei.cancel(BigInt(id), user);
  }

  @Get('goods-receipts/:id/history')
  @RequirePermission('purchasing:manage', 'inventory:view', 'inventory:receive')
  getReiHistory(@Param('id') id: string) {
    return this.activityLog.getHistory('goods_receipt', BigInt(id));
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

  @Get('purchase-returns/:id')
  @RequirePermission('purchasing:manage', 'inventory:view')
  getPvn(@Param('id') id: string) {
    return this.pvn.findOne(BigInt(id));
  }

  @Post('purchase-returns/:id/confirm-refund')
  @RequirePermission('purchasing:manage')
  confirmRefund(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.pvn.confirmRefund(BigInt(id), user);
  }
}
