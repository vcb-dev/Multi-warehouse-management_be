import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { PricingModule } from '../pricing/pricing.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CustomersModule } from '../customers/customers.module';
import { OrderExportService } from './order-export.service';
import { OrderRepository } from './order.repository';
import { OrderService } from './order.service';
import { OrdersController } from './orders.controller';
import { OrderReconcileService } from './reconcile.service';

@Module({
  imports: [
    InventoryModule,
    PricingModule,
    ActivityLogModule,
    NotificationsModule,
    CustomersModule,
  ],
  controllers: [OrdersController],
  providers: [
    OrderRepository,
    OrderService,
    OrderExportService,
    OrderReconcileService,
  ],
  exports: [OrderService, OrderRepository],
})
export class OrdersModule {}
