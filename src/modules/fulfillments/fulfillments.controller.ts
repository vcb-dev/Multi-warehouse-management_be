import {
  Body,
  Controller,
  Headers,
  Param,
  Post,
  Put,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/roles.decorator';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import {
  CancelFulfillmentDto,
  CarrierWebhookDto,
  CreatePackingDto,
  PushShipmentDto,
  UpdatePackingStatusDto,
  UpdateShipmentStatusDto,
} from './fulfillment.dto';
import { FulfillmentService } from './fulfillment.service';

@ApiTags('fulfillments')
@ApiBearerAuth()
@Controller('fulfillments')
export class FulfillmentsController {
  constructor(private fulfillments: FulfillmentService) {}

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

  /**
   * Webhook ĐTVC (GHN đăng ký URL này).
   * Public — không JWT. Nếu set GHN_WEBHOOK_SECRET thì bắt buộc header X-GHN-Webhook-Secret.
   */
  @Public()
  @Post('webhook/:provider_code')
  webhook(
    @Param('provider_code') providerCode: string,
    @Body() dto: CarrierWebhookDto,
    @Headers('x-ghn-webhook-secret') webhookSecret?: string,
  ) {
    const expected = process.env.GHN_WEBHOOK_SECRET?.trim();
    if (providerCode === 'ghn' && expected && webhookSecret !== expected) {
      throw new UnauthorizedException('Invalid webhook secret');
    }
    return this.fulfillments.webhook(providerCode, dto);
  }
}
