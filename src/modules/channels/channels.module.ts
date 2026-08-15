import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
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
  ],
})
export class ChannelsModule {}
