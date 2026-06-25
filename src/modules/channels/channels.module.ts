import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { ChannelSyncScheduler } from './channel-sync.scheduler';
import { ChannelSyncService } from './channel-sync.service';
import { ChannelsController } from './channels.controller';

@Module({
  imports: [OrdersModule],
  controllers: [ChannelsController],
  providers: [ChannelSyncService, ChannelSyncScheduler],
})
export class ChannelsModule {}
