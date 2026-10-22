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
  @RequirePermission('purchase_order:view')
  listPo(
    @Query() query: ListPurchaseOrdersQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.po.list(query, user);
  }

  @Post('purchase-orders')
  @RequirePermission('purchase_order:manage')
  @HttpCode(HttpStatus.CREATED)
  createPo(@Body() dto: CreatePurchaseOrderDto, @CurrentUser() user: AuthUser) {
    return this.po.create(dto, user);
  }

  @Get('purchase-orders/:id')
  @RequirePermission('purchase_order:view_detail')
  getPo(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.po.findOne(BigInt(id), user);
  }

  @Put('purchase-orders/:id')
  @RequirePermission('purchase_order:manage')
  updatePo(
    @Param('id') id: string,
    @Body() dto: UpdatePurchaseOrderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.po.update(BigInt(id), dto, user);
  }

  @Post('purchase-orders/:id/transition')
  @RequirePermission('purchase_order:manage')
  transitionPo(
    @Param('id') id: string,
    @Body() dto: PoTransitionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.po.transition(BigInt(id), dto.action, user);
  }

  @Get('purchase-orders/:id/history')
  @RequirePermission('purchase_order:view_detail')
  async getPoHistory(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.po.assertPoReadable(BigInt(id), user);
    return this.activityLog.getHistory('purchase_order', BigInt(id));
  }

  @Get('goods-receipts')
  @RequirePermission('goods_receipt:view')
  listRei(
    @Query() query: ListGoodsReceiptsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.rei.list(query, user);
  }

  @Post('goods-receipts')
  @RequirePermission('goods_receipt:manage')
  @HttpCode(HttpStatus.CREATED)
  createRei(@Body() dto: CreateGoodsReceiptDto, @CurrentUser() user: AuthUser) {
    return this.rei.create(dto, user);
  }

  @Get('goods-receipts/:id')
  @RequirePermission('goods_receipt:view_detail')
  getRei(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.rei.findOne(BigInt(id), user);
  }

  @Post('goods-receipts/:id/confirm')
  @RequirePermission('goods_receipt:manage')
  confirmRei(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.rei.confirm(BigInt(id), user);
  }

  @Post('goods-receipts/:id/pay')
  @RequirePermission('goods_receipt:pay')
  payRei(
    @Param('id') id: string,
    @Body() dto: PayGoodsReceiptDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.rei.pay(BigInt(id), user, dto.amount);
  }

  @Post('goods-receipts/:id/cancel')
  @RequirePermission('goods_receipt:manage')
  cancelRei(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.rei.cancel(BigInt(id), user);
  }

  @Get('goods-receipts/:id/history')
  @RequirePermission('goods_receipt:view_detail')
  async getReiHistory(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.rei.assertReceiptReadable(BigInt(id), user);
    return this.activityLog.getHistory('goods_receipt', BigInt(id));
  }

  @Get('purchase-returns')
  @RequirePermission('purchase_return:view')
  listPvn(
    @Query() query: ListPurchaseReturnsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.pvn.list(query, user);
  }

  @Post('purchase-returns')
  @RequirePermission('purchase_return:manage')
  @HttpCode(HttpStatus.CREATED)
  createPvn(
    @Body() dto: CreatePurchaseReturnDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.pvn.create(dto, user);
  }

  @Get('purchase-returns/:id')
  @RequirePermission('purchase_return:view_detail')
  getPvn(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.pvn.findOne(BigInt(id), user);
  }

  @Post('purchase-returns/:id/confirm-refund')
  @RequirePermission('purchase_return:refund')
  confirmRefund(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.pvn.confirmRefund(BigInt(id), user);
  }

  @Get('purchase-returns/:id/history')
  @RequirePermission('purchase_return:view_detail')
  async getPvnHistory(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.pvn.assertReturnReadable(BigInt(id), user);
    return this.activityLog.getHistory('purchase_return', BigInt(id));
  }
}
