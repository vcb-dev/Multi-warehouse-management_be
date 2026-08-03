import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import { Public } from '../../common/decorators/roles.decorator';
import { CarrierTicketService } from './carrier-ticket.service';
import {
  CancelFulfillmentDto,
  CarrierWebhookDto,
  CreateCarrierTicketDto,
  CreatePackingDto,
  GhnTicketCallbackDto,
  GhnWebhookDto,
  PushShipmentDto,
  ReplyCarrierTicketDto,
  UpdatePackingStatusDto,
  UpdateShipmentStatusDto,
} from './fulfillment.dto';
import { FulfillmentService } from './fulfillment.service';

@ApiTags('fulfillments')
@ApiBearerAuth()
@Controller('fulfillments')
export class FulfillmentsController {
  constructor(
    private fulfillments: FulfillmentService,
    private tickets: CarrierTicketService,
  ) {}

  @Post('packing')
  @RequirePermission('order:pack')
  createPacking(@Body() dto: CreatePackingDto, @CurrentUser() user: AuthUser) {
    return this.fulfillments.createPackingRequest(dto, user);
  }

  @Post('shipment')
  @RequirePermission('order:pack')
  pushShipment(@Body() dto: PushShipmentDto, @CurrentUser() user: AuthUser) {
    return this.fulfillments.pushShipment(dto, user);
  }

  @Put(':id/packing-status')
  @RequirePermission('order:pack')
  updatePackingStatus(
    @Param('id') id: string,
    @Body() dto: UpdatePackingStatusDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.fulfillments.updatePackingStatus(BigInt(id), dto, user);
  }

  @Post(':id/print')
  @RequirePermission('order:pack')
  markPrinted(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.fulfillments.markPrinted(BigInt(id), user);
  }

  @Post(':id/shipment-status')
  @RequirePermission('order:pack')
  updateShipmentStatus(
    @Param('id') id: string,
    @Body() dto: UpdateShipmentStatusDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.fulfillments.updateShipmentStatus(BigInt(id), dto, user);
  }

  @Post(':id/cancel')
  @RequirePermission('order:pack')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelFulfillmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.fulfillments.cancel(BigInt(id), dto, user);
  }

  // --- Ticket hỗ trợ với hãng vận chuyển (GHN) ---

  @Get('tickets')
  @RequirePermission('order:pack')
  listTickets(
    @CurrentUser() user: AuthUser,
    @Query('fulfillment_id') fulfillmentId?: string,
  ) {
    return this.tickets.list(user, fulfillmentId);
  }

  @Post('tickets')
  @RequirePermission('order:pack')
  createTicket(
    @Body() dto: CreateCarrierTicketDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tickets.create(dto, user);
  }

  @Post('tickets/:id/reply')
  @RequirePermission('order:pack')
  replyTicket(
    @Param('id') id: string,
    @Body() dto: ReplyCarrierTicketDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tickets.reply(BigInt(id), dto, user);
  }

  @Post('tickets/sync')
  @RequirePermission('order:pack')
  syncTickets() {
    return this.tickets.syncFromCarrier();
  }

  // --- Webhook của hãng ---
  // Phải khai TRƯỚC `webhook/:provider_code`, nếu không route động sẽ bắt luôn `webhook/ghn`.

  /**
   * Webhook trạng thái đơn của GHN. `@Public` vì GHN không có JWT của hệ thống này —
   * xác thực bằng đối chiếu `ShopID` trong payload với cấu hình kết nối đã lưu.
   */
  @Public()
  @Post('webhook/ghn')
  webhookGhn(@Body() dto: GhnWebhookDto) {
    return this.fulfillments.webhookGhn(dto);
  }

  /** Callback ticket của GHN — xác thực bằng `client_id`. */
  @Public()
  @Post('webhook/ghn/ticket')
  webhookGhnTicket(@Body() dto: GhnTicketCallbackDto) {
    return this.tickets.handleCallback(dto);
  }

  /** Webhook mô phỏng cho hãng chưa tích hợp API thật (cần đăng nhập). */
  @Post('webhook/:provider_code')
  @RequirePermission('order:pack')
  webhook(
    @Param('provider_code') providerCode: string,
    @Body() dto: CarrierWebhookDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.fulfillments.webhook(providerCode, dto, user);
  }
}
