import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { FulfillmentService } from './fulfillment.service';
import { FulfillmentsController } from './fulfillments.controller';
import { ShippingProviderService } from './shipping-provider.service';
import { ShippingProvidersController } from './shipping-providers.controller';

@Module({
  imports: [InventoryModule],
  controllers: [FulfillmentsController, ShippingProvidersController],
  providers: [FulfillmentService, ShippingProviderService],
  exports: [FulfillmentService],
})
export class FulfillmentsModule {}
