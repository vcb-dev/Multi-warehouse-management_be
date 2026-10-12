import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrdersModule } from '../orders/orders.module';
import { RbacModule } from '../rbac/rbac.module';
import { CarrierTicketService } from './carrier-ticket.service';
import { CodReconciliationService } from './cod-reconciliation.service';
import { FulfillmentService } from './fulfillment.service';
import { FulfillmentsController } from './fulfillments.controller';
import { ShippingProviderService } from './shipping-provider.service';
import { ShippingProvidersController } from './shipping-providers.controller';

@Module({
  // RbacModule: webhook hãng vận chuyển không mang JWT nên phải tự dựng AuthUser
  // đầy đủ quyền cho user hệ thống (xem `FulfillmentService.systemUser`).
  // OrdersModule: đối soát COD ghi tiền thu hộ vào đơn qua `OrderService.pay`.
  imports: [InventoryModule, NotificationsModule, RbacModule, OrdersModule],
  controllers: [FulfillmentsController, ShippingProvidersController],
  providers: [
    FulfillmentService,
    ShippingProviderService,
    CarrierTicketService,
    CodReconciliationService,
  ],
  exports: [FulfillmentService],
})
export class FulfillmentsModule {}
