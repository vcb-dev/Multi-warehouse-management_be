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
import { ChannelOverviewService } from './channel-overview.service';
import { ChannelSyncService } from './channel-sync.service';
import { ShopeeAuthService } from './shopee/shopee-auth.service';
import { ChannelOverviewQueryDto } from './channel.dto';
import { TiktokAuthService } from './tiktok/tiktok-auth.service';

@ApiTags('channels')
@ApiBearerAuth()
@Controller('channels')
export class ChannelsController {
  constructor(
    private sync: ChannelSyncService,
    private shopeeAuth: ShopeeAuthService,
    private tiktokAuth: TiktokAuthService,
    private overview: ChannelOverviewService,
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
   * Số liệu bán hàng theo kênh (doanh số, số đơn, đơn huỷ, trạng thái đơn) — nguồn cho
   * màn Tổng quan kênh bán. Đọc từ `orders` nên dùng quyền xem đơn, không phải `order:create`.
   */
  @Get('overview')
  @RequirePermission('order:view')
  @LocationOptional()
  getOverview(
    @Query() query: ChannelOverviewQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.overview.getOverview(query, user);
  }

  /** Danh sách shop đã ủy quyền kết nối trực tiếp (TikTok Shop, Shopee...), để hiển thị lên UI. */
  @Get('connections')
  @RequirePermission('order:create')
  @LocationOptional()
  listConnections() {
    return this.sync.listConnections();
  }

  /**
   * Redirect URL khai báo trên TikTok Shop Partner Center — TikTok gọi lại đây (GET, từ trình
   * duyệt của seller) sau khi seller đồng ý ủy quyền, kèm `code`. `@Public` vì đây không phải
   * lời gọi API có JWT của hệ thống này.
   */
  /** Link ủy quyền shop Shopee — mở trong trình duyệt (seller đăng nhập & đồng ý). */
  @Get('shopee/authorize-url')
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
  @Get('shopee/callback')
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
