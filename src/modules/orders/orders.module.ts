import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { PricingModule } from '../pricing/pricing.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { CustomerDebtService } from './customer-debt.service';
import { OrderRepository } from './order.repository';
import { OrderService } from './order.service';
import { OrdersController } from './orders.controller';
import { CustomersController } from './customers.controller';
import { OrderReconcileService } from './reconcile.service';

@Module({
  imports: [InventoryModule, PricingModule, ActivityLogModule],
  controllers: [OrdersController, CustomersController],
  providers: [
    OrderRepository,
    OrderService,
    OrderReconcileService,
    CustomerDebtService,
  ],
  exports: [OrderService, OrderRepository, CustomerDebtService],
})
export class OrdersModule {}
