import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

/**
 * Module này KHÔNG import module nghiệp vụ nào (orders/fulfillments/...) — quan hệ chỉ
 * đi một chiều: nghiệp vụ gọi sang thông báo. Giữ đúng chiều đó thì không bao giờ có
 * circular dependency khi thêm topic mới.
 */
@Module({
  imports: [RbacModule],
  controllers: [NotificationController],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationsModule {}
