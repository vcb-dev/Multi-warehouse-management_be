import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
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
import { Public } from '../../common/decorators/roles.decorator';
import { assertWebhookSecret } from '../../common/auth/webhook-secret';
import { CarrierTicketService } from './carrier-ticket.service';
import { CodReconciliationService } from './cod-reconciliation.service';
import {
  BulkMarkPrintedDto,
  BulkReconcileCodDto,
  BulkPackingStatusDto,
  CancelFulfillmentDto,
  CarrierWebhookDto,
  CreateCarrierTicketDto,
  CreatePackingDto,
  PushShipmentDto,
  ReplyCarrierTicketDto,
  UpdatePackingStatusDto,
  UpdateShipmentStatusDto,
  ListPackagesQueryDto,
  ListShipmentsQueryDto,
  ShipmentOverviewQueryDto,
  VtpWebhookDto,
} from './fulfillment.dto';
import { FulfillmentService } from './fulfillment.service';

@ApiTags('fulfillments')
@ApiBearerAuth()
@Controller('fulfillments')
export class FulfillmentsController {
  constructor(
    private fulfillments: FulfillmentService,
    private tickets: CarrierTicketService,
    private codReconciliation: CodReconciliationService,
  ) {}

  @Post('packing')
  @RequirePermission('order:pack')
  createPacking(@Body() dto: CreatePackingDto, @CurrentUser() user: AuthUser) {
    return this.fulfillments.createPackingRequest(dto, user);
  }

  @Post('shipment')
  @RequirePermission('shipment:create')
  pushShipment(@Body() dto: PushShipmentDto, @CurrentUser() user: AuthUser) {
    return this.fulfillments.pushShipment(dto, user);
  }

  // --- Màn "In & đóng gói" ---
  // Hai route POST dưới phải khai TRƯỚC `:id/print`, nếu không route động sẽ
  // bắt `packages/print` với id = "packages".

  @Get('packages')
  @RequirePermission('order:view')
  listPackages(
    @Query() query: ListPackagesQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.fulfillments.listPackages(query, user);
  }

  @Post('packages/print')
  @HttpCode(200)
  @RequirePermission('order:pack')
  bulkMarkPrinted(
    @Body() dto: BulkMarkPrintedDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.fulfillments.bulkMarkPrinted(dto, user);
  }

  @Post('packages/packing-status')
  @HttpCode(200)
  @RequirePermission('order:pack')
  bulkUpdatePackingStatus(
    @Body() dto: BulkPackingStatusDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.fulfillments.bulkUpdatePackingStatus(dto, user);
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
  @RequirePermission('shipment:create')
  updateShipmentStatus(
    @Param('id') id: string,
    @Body() dto: UpdateShipmentStatusDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.fulfillments.updateShipmentStatus(BigInt(id), dto, user);
  }

  @Post(':id/cancel')
  @RequirePermission('shipment:cancel')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelFulfillmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.fulfillments.cancel(BigInt(id), dto, user);
  }

  // --- Ticket hỗ trợ với hãng vận chuyển ---

  @Get('tickets')
  @RequirePermission('carrier_ticket:manage')
  listTickets(
    @CurrentUser() user: AuthUser,
    @Query('fulfillment_id') fulfillmentId?: string,
  ) {
    return this.tickets.list(user, fulfillmentId);
  }

  @Post('tickets')
  @RequirePermission('carrier_ticket:manage')
  createTicket(
    @Body() dto: CreateCarrierTicketDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tickets.create(dto, user);
  }

  @Post('tickets/:id/reply')
  @RequirePermission('carrier_ticket:manage')
  replyTicket(
    @Param('id') id: string,
    @Body() dto: ReplyCarrierTicketDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tickets.reply(BigInt(id), dto, user);
  }

  @Post('tickets/sync')
  @RequirePermission('carrier_ticket:manage')
  syncTickets() {
    return this.tickets.syncFromCarrier();
  }

  // --- Webhook của hãng ---
  // Phải khai TRƯỚC `webhook/:provider_code`, nếu không route động sẽ bắt luôn `webhook/vtp`.

  /**
   * Webhook trạng thái đơn của ViettelPost. Theo tài liệu chính thức
   * (`partner2.viettelpost.vn/document/webhook`): header `Authorization` là "token xác thực",
   * còn payload mẫu cũng có field `TOKEN` (dạng số điện thoại tài khoản) ở ngoài `DATA` — tài
   * liệu không nói rõ field nào mới thật sự là "tham số bí mật" cấu hình lúc đăng ký webhook, nên
   * chấp nhận khớp 1 trong 2 (đối chiếu thật khi có tài khoản dev để test webhook thật).
   * BẮT BUỘC trả HTTP 200 (không phải 201 mặc định của NestJS) — nếu không VTP coi là thất bại
   * và retry tối đa 5 lần liên tục cho cùng một bản ghi hành trình.
   * Trả lời ngay sau khi xác thực, phần xử lý chạy nền (VTP đòi phản hồi dưới 1 giây).
   */
  @Public()
  @Post('webhook/vtp')
  @HttpCode(200)
  webhookVtp(
    @Body() dto: VtpWebhookDto,
    @Headers('authorization') authHeader?: string,
  ) {
    const headerToken = authHeader?.replace(/^Bearer\s+/i, '').trim();
    const bodyToken = dto.TOKEN?.trim();
    assertWebhookSecret('VTP_WEBHOOK_SECRET', headerToken, bodyToken);
    this.fulfillments.enqueueVtpWebhook(dto);
    return { received: true };
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

  @Get('shipments/overview')
  @RequirePermission('shipment:view')
  getShipmentOverview(
    @Query() query: ShipmentOverviewQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.fulfillments.getShipmentOverview(query, user);
  }

  /** Đối soát COD — ghi tiền thu hộ vào đơn nên đòi quyền cập nhật đơn. */
  @Post('shipments/reconcile')
  @HttpCode(200)
  @RequirePermission('shipment:reconcile')
  reconcileCod(
    @Body() dto: BulkReconcileCodDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.codReconciliation.reconcileMany(dto, user);
  }

  @Get('shipments')
  @RequirePermission('shipment:view')
  listShipments(
    @Query() query: ListShipmentsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.fulfillments.listShipments(query, user);
  }
}
