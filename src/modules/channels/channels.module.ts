import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrdersModule } from '../orders/orders.module';
import { ChannelOverviewService } from './channel-overview.service';
import { ChannelSyncScheduler } from './channel-sync.scheduler';
import { ChannelSyncService } from './channel-sync.service';
import { ChannelsController } from './channels.controller';
import { ShopeeAuthService } from './shopee/shopee-auth.service';
import { TiktokAuthService } from './tiktok/tiktok-auth.service';
import { TiktokOrderSyncService } from './tiktok/tiktok-order-sync.service';
import { TiktokWebhookService } from './tiktok/tiktok-webhook.service';

@Module({
  imports: [OrdersModule, NotificationsModule],
  controllers: [ChannelsController],
  providers: [
    ChannelSyncService,
    ChannelSyncScheduler,
    ShopeeAuthService,
    TiktokAuthService,
    TiktokOrderSyncService,
    TiktokWebhookService,
    ChannelOverviewService,
  ],
})
export class ChannelsModule {}
