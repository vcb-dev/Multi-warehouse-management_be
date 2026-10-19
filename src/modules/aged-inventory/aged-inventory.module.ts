import { Module } from '@nestjs/common';
import { SapoClient } from '../products/sapo-sync/sapo-client';
import { AgedInventoryController } from './aged-inventory.controller';
import { AgedInventoryQueryService } from './aged-inventory-query.service';
import { AgedInventorySnapshotService } from './aged-inventory-snapshot.service';

@Module({
  controllers: [AgedInventoryController],
  providers: [
    // SapoClient không có dependency (đọc thẳng env) — khai lại như ChannelsModule.
    SapoClient,
    AgedInventorySnapshotService,
    AgedInventoryQueryService,
  ],
})
export class AgedInventoryModule {}
