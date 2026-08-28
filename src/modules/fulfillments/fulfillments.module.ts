import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RbacModule } from '../rbac/rbac.module';
import { CarrierTicketService } from './carrier-ticket.service';
import { FulfillmentService } from './fulfillment.service';
import { FulfillmentsController } from './fulfillments.controller';
import { ShippingProviderService } from './shipping-provider.service';
import { ShippingProvidersController } from './shipping-providers.controller';

@Module({
  // RbacModule: webhook hãng vận chuyển không mang JWT nên phải tự dựng AuthUser
  // đầy đủ quyền cho user hệ thống (xem `FulfillmentService.systemUser`).
  imports: [InventoryModule, NotificationsModule, RbacModule],
  controllers: [FulfillmentsController, ShippingProvidersController],
  providers: [
    FulfillmentService,
    ShippingProviderService,
    CarrierTicketService,
  ],
  exports: [FulfillmentService],
})
export class FulfillmentsModule {}
