import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { StocktakeController } from './stocktake.controller';
import { StocktakeService } from './stocktake.service';

@Module({
  imports: [InventoryModule],
  controllers: [StocktakeController],
  providers: [StocktakeService],
  exports: [StocktakeService],
})
export class StocktakesModule {}
