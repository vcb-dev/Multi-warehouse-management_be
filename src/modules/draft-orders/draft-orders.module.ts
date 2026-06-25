import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { DraftOrderController } from './draft-order.controller';
import { DraftOrderService } from './draft-order.service';

@Module({
  imports: [OrdersModule],
  controllers: [DraftOrderController],
  providers: [DraftOrderService],
})
export class DraftOrdersModule {}
