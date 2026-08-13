import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import {
  LocationOptional,
  RequirePermission,
} from '../../common/decorators/permissions.decorator';
import { Public } from '../../common/decorators/roles.decorator';
import { ChannelWebhookDto } from '../orders/order.dto';
import { ChannelSyncService } from './channel-sync.service';
import { TiktokAuthService } from './tiktok/tiktok-auth.service';

@ApiTags('channels')
@ApiBearerAuth()
@Controller('channels')
export class ChannelsController {
  constructor(
    private sync: ChannelSyncService,
    private tiktokAuth: TiktokAuthService,
  ) {}

  @Post('webhook')
  @RequirePermission('order:create')
  @LocationOptional()
  webhook(@Body() dto: ChannelWebhookDto, @CurrentUser() user: AuthUser) {
    return this.sync.handleWebhook(dto, user);
  }

  @Post('sync')
  @RequirePermission('order:create')
  @LocationOptional()
  syncConnected(@CurrentUser() user: AuthUser) {
    return this.sync.syncConnectedChannels(user);
  }

  /**
   * Redirect URL khai báo trên TikTok Shop Partner Center — TikTok gọi lại đây (GET, từ trình
   * duyệt của seller) sau khi seller đồng ý ủy quyền, kèm `code`. `@Public` vì đây không phải
   * lời gọi API có JWT của hệ thống này.
   */
  @Public()
  @Get('tiktok/callback')
  async tiktokCallback(
    @Query('code') code?: string,
    @Query('error') error?: string,
  ) {
    if (error || !code) {
      return {
        ok: false,
        message: 'Ủy quyền TikTok Shop thất bại hoặc bị từ chối',
      };
    }
    const conn = await this.tiktokAuth.handleAuthorizationCode(code);
    return {
      ok: true,
      shop_id: conn.shopId,
      shop_name: conn.shopName,
    };
  }
}
