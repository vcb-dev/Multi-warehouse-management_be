import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  AuthUser,
} from '../../../common/decorators/current-user.decorator';
import {
  LocationOptional,
  RequirePermission,
} from '../../../common/decorators/permissions.decorator';
import { Public } from '../../../common/decorators/roles.decorator';
import { ShopeeAuthService } from './shopee-auth.service';
import {
  ShopeePushWebhookService,
  type ShopeePushPayload,
} from './shopee-push-webhook.service';
import { ShopeeSyncService } from './shopee-sync.service';

@ApiTags('channels')
@ApiBearerAuth()
@Controller('channels/shopee')
export class ShopeeController {
  constructor(
    private shopeeAuth: ShopeeAuthService,
    private shopeeSync: ShopeeSyncService,
    private shopeePush: ShopeePushWebhookService,
  ) {}

  @Public()
  @Get('push')
  @HttpCode(200)
  shopeePushProbe() {
    return { ok: true };
  }

  /**
   * Push Mechanism Shopee (order_status_push, code 3). Đăng ký URL này trên Shopee Console.
   * Payload chỉ dùng ordersn + shop_id; nội dung đơn kéo lại qua Open API.
   */
  @Public()
  @Post('push')
  @HttpCode(200)
  async shopeePushNotify(
    @Req() req: RawBodyRequest<Request>,
    @Body() payload: ShopeePushPayload,
    @Headers('authorization') authorization?: string,
  ) {
    const raw = req.rawBody?.toString('utf8') ?? '';
    const callbackUrl = this.shopeePush.resolveCallbackUrl();
    const valid = this.shopeePush.verifySignature(
      callbackUrl,
      raw,
      authorization,
    );
    if (!valid && this.shopeePush.isStrict()) {
      throw new UnauthorizedException('Chữ ký push Shopee không hợp lệ');
    }
    return this.shopeePush.handleNotification(payload, valid);
  }

  /** Kéo đơn từ Shopee Open Platform (sandbox/production theo SHOPEE_ENV). */
  @Post('sync')
  @RequirePermission('order:create')
  @LocationOptional()
  syncShopee(
    @CurrentUser() user: AuthUser,
    @Query('connection_id') connectionId?: string,
  ) {
    return this.shopeeSync.syncShopeeOrders(user.userId, connectionId);
  }

  /** Link ủy quyền shop Shopee — mở trong trình duyệt (seller đăng nhập & đồng ý). */
  @Get('authorize-url')
  @RequirePermission('order:create')
  @LocationOptional()
  getShopeeAuthorizeUrl() {
    return { url: this.shopeeAuth.getAuthorizeUrl() };
  }

  /**
   * Redirect URL khai báo trên Shopee Open Platform — Shopee gọi lại (GET) sau khi seller
   * ủy quyền, kèm `code` và `shop_id`.
   */
  @Public()
  @Get('callback')
  async shopeeCallback(
    @Query('code') code?: string,
    @Query('shop_id') shopId?: string,
    @Query('error') error?: string,
  ) {
    if (error || !code || !shopId) {
      return {
        ok: false,
        message: 'Ủy quyền Shopee thất bại hoặc thiếu code/shop_id',
      };
    }
    const conn = await this.shopeeAuth.handleAuthorizationCallback(
      code,
      shopId,
    );
    return {
      ok: true,
      shop_id: conn.shopId,
      shop_name: conn.shopName,
    };
  }
}
