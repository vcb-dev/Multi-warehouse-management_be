import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { VouchersModule } from '../vouchers/vouchers.module';
import { GoodsReceiptService } from './goods-receipt.service';
import { PurchaseOrderService } from './purchase-order.service';
import { PurchaseReturnService } from './purchase-return.service';
import { PurchasingController } from './purchasing.controller';

@Module({
  imports: [InventoryModule, ActivityLogModule, VouchersModule],
  controllers: [PurchasingController],
  providers: [PurchaseOrderService, GoodsReceiptService, PurchaseReturnService],
  exports: [PurchaseOrderService, GoodsReceiptService, PurchaseReturnService],
})
export class PurchasingModule {}
