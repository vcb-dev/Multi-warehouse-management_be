import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { PricingModule } from '../pricing/pricing.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CustomerDebtService } from './customer-debt.service';
import { OrderExportService } from './order-export.service';
import { OrderRepository } from './order.repository';
import { OrderService } from './order.service';
import { OrdersController } from './orders.controller';
import { CustomersController } from './customers.controller';
import { CustomerGroupsController } from './customer-groups.controller';
import { CustomerService } from './customer.service';
import { CustomerGroupService } from './customer-group.service';
import { OrderReconcileService } from './reconcile.service';

@Module({
  imports: [
    InventoryModule,
    PricingModule,
    ActivityLogModule,
    NotificationsModule,
  ],
  controllers: [
    OrdersController,
    CustomersController,
    CustomerGroupsController,
  ],
  providers: [
    CustomerService,
    CustomerGroupService,
    OrderRepository,
    OrderService,
    OrderExportService,
    OrderReconcileService,
    CustomerDebtService,
  ],
  exports: [OrderService, OrderRepository, CustomerDebtService],
})
export class OrdersModule {}
