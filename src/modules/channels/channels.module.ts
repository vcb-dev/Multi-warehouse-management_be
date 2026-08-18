import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrdersModule } from '../orders/orders.module';
import { RbacModule } from '../rbac/rbac.module';
import { ChannelOverviewService } from './channel-overview.service';
import { ChannelSyncScheduler } from './channel-sync.scheduler';
import { ChannelSyncService } from './channel-sync.service';
import { ChannelsController } from './channels.controller';
import { ShopeeAuthService } from './shopee/shopee-auth.service';
import { ShopeePushWebhookService } from './shopee/shopee-push-webhook.service';
import { ShopeeSyncService } from './shopee/shopee-sync.service';
import { TiktokAuthService } from './tiktok/tiktok-auth.service';
import { TiktokOrderSyncService } from './tiktok/tiktok-order-sync.service';
import { TiktokReturnSyncService } from './tiktok/tiktok-return-sync.service';
import { TiktokWebhookService } from './tiktok/tiktok-webhook.service';

@Module({
  imports: [OrdersModule, RbacModule, NotificationsModule],
  controllers: [ChannelsController],
  providers: [
    ChannelSyncService,
    ChannelSyncScheduler,
    ShopeeAuthService,
    ShopeeSyncService,
    ShopeePushWebhookService,
    TiktokAuthService,
    TiktokOrderSyncService,
    TiktokReturnSyncService,
    TiktokWebhookService,
    ChannelOverviewService,
  ],
})
export class ChannelsModule {}
