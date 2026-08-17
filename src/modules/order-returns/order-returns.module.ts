import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrdersModule } from '../orders/orders.module';
import { OrderReturnController } from './order-return.controller';
import { OrderReturnService } from './order-return.service';

@Module({
  imports: [InventoryModule, OrdersModule, NotificationsModule],
  controllers: [OrderReturnController],
  providers: [OrderReturnService],
})
export class OrderReturnsModule {}
