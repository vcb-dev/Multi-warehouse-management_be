import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { StockTransferController } from './stock-transfer.controller';
import { StockTransferService } from './stock-transfer.service';

@Module({
  imports: [InventoryModule],
  controllers: [StockTransferController],
  providers: [StockTransferService],
  exports: [StockTransferService],
})
export class TransfersModule {}
