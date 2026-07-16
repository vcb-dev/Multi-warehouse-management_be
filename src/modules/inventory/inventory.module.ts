import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import {
  InventoryExportService,
  InventoryImportService,
} from './inventory-import-export.service';
import { InventoryNxtService } from './inventory-nxt.service';
import { InventoryQueryService } from './inventory-query.service';
import { InventoryRepository } from './inventory.repository';
import { InventoryService } from './inventory.service';
import { ReconcileScheduler } from './reconcile.scheduler';
import { ReconcileService } from './reconcile.service';

@Module({
  controllers: [InventoryController],
  providers: [
    InventoryRepository,
    InventoryService,
    InventoryNxtService,
    InventoryQueryService,
    InventoryExportService,
    InventoryImportService,
    ReconcileService,
    ReconcileScheduler,
  ],
  exports: [InventoryService, InventoryRepository, ReconcileService],
})
export class InventoryModule {}
