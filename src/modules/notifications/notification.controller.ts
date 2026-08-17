import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import {
  ListNotificationsQueryDto,
  MarkReadDto,
  UpdateNotificationSettingDto,
} from './notification.dto';
import { NotificationService } from './notification.service';

/**
 * Trung tâm thông báo in-app.
 *
 * 4 route đầu KHÔNG gắn `@RequirePermission` — ai đăng nhập cũng có chuông của mình.
 * An toàn không đến từ guard mà từ việc mọi truy vấn trong service đều khoá cứng
 * `userId: user.userId`; bỏ điều kiện đó ở bất kỳ đâu là user này đọc được thông báo
 * của user khác. Đừng "tối ưu" nó đi.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationController {
  constructor(private notifications: NotificationService) {}

  @Get()
  list(
    @Query() query: ListNotificationsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.notifications.list(user, query);
  }

  @Get('unread-count')
  unreadCount(@CurrentUser() user: AuthUser) {
    return this.notifications.unreadCount(user);
  }

  @Post('read')
  markRead(@Body() dto: MarkReadDto, @CurrentUser() user: AuthUser) {
    return this.notifications.markRead(user, dto.ids);
  }

  @Post('read-all')
  markAllRead(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(user);
  }

  // --- Cấu hình (trang /cau-hinh/thong-bao) ---

  @Get('settings')
  @RequirePermission('notification:manage')
  getSettings() {
    return this.notifications.getSettings();
  }

  /** `:topic` là chuỗi Sapo có dấu `/` (vd `orders/create`) nên phải nhận 2 đoạn path. */
  @Put('settings/:resource/:action')
  @RequirePermission('notification:manage')
  updateSetting(
    @Param('resource') resource: string,
    @Param('action') action: string,
    @Body() dto: UpdateNotificationSettingDto,
  ) {
    return this.notifications.updateSetting(`${resource}/${action}`, dto);
  }
}
