import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
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
import { SapoInventorySyncService } from './sapo/sapo-inventory-sync.service';
import { SapoLocationSyncService } from './sapo/sapo-location-sync.service';
import { SapoOrderSyncService } from './sapo/sapo-order-sync.service';
import {
  ChannelOverviewQueryDto,
  UpdateChannelConnectionDto,
} from './channel.dto';
import { TiktokAuthService } from './tiktok/tiktok-auth.service';
import { TiktokSyncDto } from './tiktok/tiktok.dto';
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
    private sapoOrders: SapoOrderSyncService,
    private sapoInventory: SapoInventorySyncService,
    private sapoLocations: SapoLocationSyncService,
    private overview: ChannelOverviewService,
  ) {}

  /**
   * TikTok gọi thử URL trước khi cho lưu ở Partner Center, và một số lần thử dùng GET.
   * Không có route GET thì Nest trả 404, Partner Center báo lại bằng đúng một chữ
   * "internal error" (`code: 98001001`) chẳng nói gì về nguyên nhân. Route này chỉ để
   * bước xác thực URL đi qua — không xử lý nghiệp vụ gì.
   */
  @Public()
  @Get('tiktok/webhook')
  @HttpCode(200)
  tiktokWebhookProbe() {
    return { ok: true };
  }

  /**
   * Nhận thông báo đẩy của TikTok Shop (khai URL này ở Partner Center, mục Webhooks).
   * `@Public` vì TikTok gọi tới, không mang JWT của hệ thống.
   *
   * Payload chỉ được dùng để lấy `order_id`; nội dung đơn luôn lấy lại từ API bằng token
   * của mình — xem `TiktokWebhookService`. Luôn trả 200 kể cả khi bỏ qua, vì TikTok coi
   * mã lỗi là "gửi hụt" và sẽ gửi lại nhiều lần.
   *
   * `@HttpCode(200)`: mặc định của Nest cho POST là 201, mà nhiều bộ kiểm tra webhook chỉ
   * chấp nhận đúng 200 — không đáng mạo hiểm để 201 rồi ngồi đoán vì sao TikTok từ chối.
   */
  @Public()
  @Post('tiktok/webhook')
  @HttpCode(200)
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

  /**
   * Kéo đơn mới từ Sapo ngay, không chờ cron. `since` (ISO) để chạy bù một khoảng cũ;
   * bỏ trống thì lấy từ đơn Sapo mới nhất đang có trong DB.
   */
  @Post('sapo/sync')
  @RequirePermission('order:create')
  @LocationOptional()
  syncSapo(@Query('since') since?: string) {
    return this.sapoOrders.syncNewOrders(since);
  }

  /**
   * Kéo danh sách kho/chi nhánh từ Sapo. Chạy trước khi đồng bộ đơn/tồn nếu vừa lập kho mới
   * bên Sapo — không có kho thì đơn của nó bị gán tạm vào kho mặc định.
   */
  @Post('sapo/location-sync')
  @RequirePermission('inventory:receive')
  @LocationOptional()
  syncSapoLocations() {
    return this.sapoLocations.syncLocations();
  }

  /**
   * Kéo lại tồn kho từ Sapo ngay, không chờ cron. Quét cả catalog nên chạy vài phút —
   * `inventory:receive` chứ không phải `order:create`: đây là thao tác sửa tồn.
   */
  @Post('sapo/inventory-sync')
  @RequirePermission('inventory:receive')
  @LocationOptional()
  syncSapoInventory() {
    return this.sapoInventory.syncInventoryLevels();
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

  @Patch('connections/:id')
  @RequirePermission('order:create')
  @LocationOptional()
  updateConnection(
    @Param('id') id: string,
    @Body() dto: UpdateChannelConnectionDto,
  ) {
    return this.sync.updateConnectionLocation(id, dto.location_id);
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
