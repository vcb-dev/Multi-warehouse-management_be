import {
  Body,
  Controller,
  Get,
  Headers,
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
} from '../../common/decorators/current-user.decorator';
import {
  LocationOptional,
  RequirePermission,
} from '../../common/decorators/permissions.decorator';
import { Public } from '../../common/decorators/roles.decorator';
import { ChannelWebhookDto } from '../orders/order.dto';
import { ChannelOverviewService } from './channel-overview.service';
import { ChannelSyncService } from './channel-sync.service';
import { ChannelOverviewQueryDto, TiktokSyncDto } from './channel.dto';
import { TiktokAuthService } from './tiktok/tiktok-auth.service';
import { TiktokOrderSyncService } from './tiktok/tiktok-order-sync.service';
import {
  TiktokWebhookService,
  type TiktokWebhookPayload,
} from './tiktok/tiktok-webhook.service';

@ApiTags('channels')
@ApiBearerAuth()
@Controller('channels')
export class ChannelsController {
  constructor(
    private sync: ChannelSyncService,
    private tiktokAuth: TiktokAuthService,
    private tiktokOrders: TiktokOrderSyncService,
    private tiktokWebhook: TiktokWebhookService,
    private overview: ChannelOverviewService,
  ) {}

  /**
   * Nhận thông báo đẩy của TikTok Shop (khai URL này ở Partner Center, mục Webhooks).
   * `@Public` vì TikTok gọi tới, không mang JWT của hệ thống.
   *
   * Payload chỉ được dùng để lấy `order_id`; nội dung đơn luôn lấy lại từ API bằng token
   * của mình — xem `TiktokWebhookService`. Luôn trả 200 kể cả khi bỏ qua, vì TikTok coi
   * mã lỗi là "gửi hụt" và sẽ gửi lại nhiều lần.
   */
  @Public()
  @Post('tiktok/webhook')
  async tiktokWebhookNotify(
    @Req() req: RawBodyRequest<Request>,
    @Body() payload: TiktokWebhookPayload,
    @Headers('authorization') authorization?: string,
  ) {
    const raw = req.rawBody?.toString('utf8') ?? '';
    const valid = this.tiktokWebhook.verifySignature(raw, authorization);
    if (!valid && this.tiktokWebhook.isStrict()) {
      throw new UnauthorizedException('Chữ ký webhook TikTok không hợp lệ');
    }
    return this.tiktokWebhook.handleNotification(payload, valid);
  }

  /**
   * Kéo đơn thẳng từ TikTok Shop Open API vào `orders` (không qua Sapo). Chạy đồng bộ nên
   * khoảng thời gian mặc định để ngắn (7 ngày); muốn lấy bù cả tháng thì truyền `from`/`to`.
   */
  @Post('tiktok/sync')
  @RequirePermission('order:create')
  @LocationOptional()
  syncTiktok(@Body() dto: TiktokSyncDto, @CurrentUser() user: AuthUser) {
    return this.tiktokOrders.syncOrders({
      from: dto.from,
      to: dto.to,
      filterBy: dto.filter_by,
      createdById: user.userId,
    });
  }

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
