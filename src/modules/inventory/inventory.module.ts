import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { InventoryAlertScheduler } from './inventory-alert.scheduler';
import { InventoryAlertService } from './inventory-alert.service';
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
  imports: [NotificationsModule],
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
    InventoryAlertService,
    InventoryAlertScheduler,
  ],
  exports: [
    InventoryService,
    InventoryRepository,
    ReconcileService,
    InventoryAlertService,
  ],
})
export class InventoryModule {}
