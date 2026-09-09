import { Module } from '@nestjs/common';
import { ShopeeAuthService } from './shopee-auth.service';
import { ShopeeController } from './shopee.controller';
import { ShopeePushWebhookService } from './shopee-push-webhook.service';
import { ShopeeSyncScheduler } from './shopee-sync.scheduler';
import { ShopeeSyncService } from './shopee-sync.service';

@Module({
  controllers: [ShopeeController],
  providers: [
    ShopeeAuthService,
    ShopeeSyncService,
    ShopeePushWebhookService,
    ShopeeSyncScheduler,
  ],
  exports: [ShopeeSyncService],
})
export class ShopeeModule {}
