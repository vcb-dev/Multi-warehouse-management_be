import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { OrderReturnController } from './order-return.controller';
import { OrderReturnService } from './order-return.service';

@Module({
  imports: [InventoryModule],
  controllers: [OrderReturnController],
  providers: [OrderReturnService],
})
export class OrderReturnsModule {}
