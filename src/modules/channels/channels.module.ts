import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrdersModule } from '../orders/orders.module';
import { RbacModule } from '../rbac/rbac.module';
import { SapoClient } from '../products/sapo-sync/sapo-client';
import { SapoInventorySyncService } from './sapo/sapo-inventory-sync.service';
import { SapoLocationSyncService } from './sapo/sapo-location-sync.service';
import { SapoOrderSyncService } from './sapo/sapo-order-sync.service';
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
  imports: [OrdersModule, RbacModule, NotificationsModule, InventoryModule],
  controllers: [ChannelsController],
  providers: [
    // SapoClient không có dependency nào (đọc thẳng env) nên khai lại ở đây rẻ hơn
    // là kéo cả ProductsModule vào chỉ để lấy một client.
    SapoClient,
    SapoOrderSyncService,
    SapoInventorySyncService,
    SapoLocationSyncService,
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
