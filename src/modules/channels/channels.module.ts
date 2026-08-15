import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { ChannelOverviewService } from './channel-overview.service';
import { ChannelSyncScheduler } from './channel-sync.scheduler';
import { ChannelSyncService } from './channel-sync.service';
import { ChannelsController } from './channels.controller';
import { TiktokAuthService } from './tiktok/tiktok-auth.service';

@Module({
  imports: [OrdersModule],
  controllers: [ChannelsController],
  providers: [
    ChannelSyncService,
    ChannelSyncScheduler,
    TiktokAuthService,
    ChannelOverviewService,
  ],
})
export class ChannelsModule {}
