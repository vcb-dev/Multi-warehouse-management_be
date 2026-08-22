import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { CustomerDebtService } from './customer-debt.service';
import { CustomerGroupService } from './customer-group.service';
import { CustomerGroupsController } from './customer-groups.controller';
import { CustomerService } from './customer.service';
import { CustomersController } from './customers.controller';

/**
 * Khách hàng, nhóm khách và sổ công nợ. Tách khỏi OrdersModule ngày 21/08/2026 —
 * trước đó cả ba sống chung trong `modules/orders` dù route (`/customers`,
 * `/customer-groups`) luôn ngang hàng `/orders`, không lồng nhau.
 *
 * Quan hệ đi MỘT CHIỀU: orders → customers (đơn ghi sổ công nợ qua
 * `CustomerDebtService`). Module này không được import ngược OrdersModule,
 * giữ vậy thì không bao giờ có circular dependency.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [CustomersController, CustomerGroupsController],
  providers: [CustomerService, CustomerGroupService, CustomerDebtService],
  exports: [CustomerService, CustomerGroupService, CustomerDebtService],
})
export class CustomersModule {}
