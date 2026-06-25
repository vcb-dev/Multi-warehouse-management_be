import { Module } from '@nestjs/common';
import { PricingController } from './pricing.controller';
import { PriceListService } from './price-list.service';

@Module({
  controllers: [PricingController],
  providers: [PriceListService],
  exports: [PriceListService],
})
export class PricingModule {}
