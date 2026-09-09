import { Injectable, Logger } from '@nestjs/common';
import { NotificationTopic } from '@prisma/client';
import { NotificationService } from '../notifications/notification.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Báo khi một luồng đồng bộ kênh bán chết.
 *
 * Vì sao tồn tại: đồng bộ đơn Sapo chết từ 03/08/2026 và chỉ bị phát hiện khi có người
 * ngồi đối chiếu tay — lúc đó đã thiếu 3.043 đơn. Suốt thời gian đó scheduler vẫn chạy
 * đều và vẫn `logger.error()` mỗi lượt, nhưng log Railway thì không ai mở hằng ngày.
 * Đây là loại hỏng hóc mà càng lâu phát hiện càng đắt, và không có màn hình nào trong app
 * hiện nó ra — đúng thứ mà chuông sinh ra để làm.
 */
@Injectable()
export class ChannelSyncAlertService {
  private readonly logger = new Logger(ChannelSyncAlertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Ghi nhận một lượt đồng bộ thất bại.
   *
   * Không `await` ở nơi gọi và không bao giờ throw: đây nằm trong `catch` của cron, ném
   * tiếp thì nuốt mất lỗi gốc.
   *
   * @param job Tên luồng người đọc hiểu được, vd `Đơn Sapo`. Cũng là khoá chống lặp.
   */
  report(job: string, error: unknown) {
    void this.emit(job, error).catch((e) =>
      this.logger.error(
        `Không ghi được cảnh báo sync cho "${job}": ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }

  private async emit(job: string, error: unknown) {
    if (await this.isStillUnread(job)) return;

    const reason =
      error instanceof Error ? error.message.split('\n')[0] : String(error);

    await this.notifications.emit(NotificationTopic.channel_sync_failed, {
      subjectType: 'channel',
      // Không có id ổn định cho "một luồng đồng bộ" (Sapo không có dòng
      // `channel_connections` nào), nên định danh nằm ở `payload.channel`. `subjectId`
      // để 0 chứ không bịa id giả — serializer cũng không dùng tới nó cho nhánh này.
      subjectId: 0n,
      // Sync là việc toàn hệ thống, không thuộc kho nào ⇒ mọi người có quyền đều nhận.
      locationId: null,
      title: `Đồng bộ ${job} đang lỗi`,
      payload: { channel: job, reason },
    });
  }

  /**
   * Bỏ qua nếu cảnh báo trước cho đúng luồng này vẫn còn người chưa đọc.
   *
   * Cron chạy mỗi 15–30 phút và hỏng thì hỏng liên tục: không có chặn này thì một kênh
   * chết qua đêm sinh ~30 thông báo giống hệt nhau. Khi đã có người đọc, lượt hỏng tiếp
   * theo báo lại — vì lúc đó im lặng mới là nguy hiểm.
   *
   * Khoá theo `payload.channel` chứ không theo `subjectId`: mọi luồng đều dùng
   * `subjectId = 0`, khoá theo nó thì Sapo hỏng sẽ nuốt mất cảnh báo TikTok hỏng.
   */
  private async isStillUnread(job: string) {
    const last = await this.prisma.notification.findFirst({
      where: {
        topic: NotificationTopic.channel_sync_failed,
        payload: { path: ['channel'], equals: job },
      },
      orderBy: { id: 'desc' },
      select: {
        recipients: {
          where: { readOn: null },
          select: { userId: true },
          take: 1,
        },
      },
    });
    return !!last?.recipients.length;
  }
}
