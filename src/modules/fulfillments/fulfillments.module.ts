import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { CarrierTicketService } from './carrier-ticket.service';
import { FulfillmentService } from './fulfillment.service';
import { FulfillmentsController } from './fulfillments.controller';
import { ShippingProviderService } from './shipping-provider.service';
import { ShippingProvidersController } from './shipping-providers.controller';

@Module({
  imports: [InventoryModule],
  controllers: [FulfillmentsController, ShippingProvidersController],
  providers: [
    FulfillmentService,
    ShippingProviderService,
    CarrierTicketService,
  ],
  exports: [FulfillmentService],
})
export class FulfillmentsModule {}
