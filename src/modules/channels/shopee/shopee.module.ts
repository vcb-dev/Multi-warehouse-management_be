import { Module } from '@nestjs/common';
import { ShopeeAuthService } from './shopee-auth.service';
import { ShopeeController } from './shopee.controller';
import { ShopeeInventorySyncService } from './shopee-inventory-sync.service';
import { ShopeePushWebhookService } from './shopee-push-webhook.service';
import { ShopeeSyncScheduler } from './shopee-sync.scheduler';
import { ShopeeSyncService } from './shopee-sync.service';

@Module({
  controllers: [ShopeeController],
  providers: [
    ShopeeAuthService,
    ShopeeSyncService,
    ShopeeInventorySyncService,
    ShopeePushWebhookService,
    ShopeeSyncScheduler,
  ],
  exports: [ShopeeSyncService, ShopeeInventorySyncService],
})
export class ShopeeModule {}
