import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { ChannelOverviewService } from './channel-overview.service';
import { ChannelSyncScheduler } from './channel-sync.scheduler';
import { ChannelSyncService } from './channel-sync.service';
import { ChannelsController } from './channels.controller';
import { ShopeeAuthService } from './shopee/shopee-auth.service';
import { TiktokAuthService } from './tiktok/tiktok-auth.service';

@Module({
  imports: [OrdersModule],
  controllers: [ChannelsController],
  providers: [
    ChannelSyncService,
    ChannelSyncScheduler,
    ShopeeAuthService,
    TiktokAuthService,
    TiktokAuthService,
    ChannelOverviewService,
  ],
})
export class ChannelsModule {}
