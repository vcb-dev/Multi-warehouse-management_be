import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { UserRole } from '@prisma/client';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { ChannelSyncService } from './channel-sync.service';
import { TiktokOrderSyncService } from './tiktok/tiktok-order-sync.service';

/**
 * Cửa sổ quét của cron TikTok, tính bằng phút. Phải RỘNG HƠN chu kỳ chạy để hai lần quét
 * chồng lấn: sync là idempotent (upsert theo `orders.name`) nên quét trùng vô hại, còn
 * quét hụt vì lệch giờ hoặc một lần chạy lỗi thì đơn mất luôn.
 */
const TIKTOK_WINDOW_MINUTES = Number(
  process.env.TIKTOK_SYNC_WINDOW_MINUTES ?? 30,
);

@Injectable()
export class ChannelSyncScheduler {
  private readonly logger = new Logger(ChannelSyncScheduler.name);
  /** Chặn hai lần chạy chồng nhau khi một lần quét kéo dài quá chu kỳ cron. */
  private tiktokRunning = false;

  constructor(
    private readonly sync: ChannelSyncService,
    private readonly tiktokOrders: TiktokOrderSyncService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Kéo đơn TikTok định kỳ. Quét theo `update_time` chứ không phải `create_time`: đơn
   * TikTok đổi trạng thái rất lâu sau khi tạo (đo 2026-08-15: 182 đơn đổi trạng thái
   * trong 24h, tất cả tạo từ 16/07), lọc theo ngày tạo sẽ không bao giờ thấy chúng.
   */
  @Cron(process.env.TIKTOK_SYNC_CRON ?? CronExpression.EVERY_30_MINUTES)
  async pollTiktokOrders() {
    if (process.env.TIKTOK_SYNC_CRON_ENABLED !== 'true') return;
    if (this.tiktokRunning) {
      this.logger.warn('Cron TikTok: lần chạy trước chưa xong, bỏ lượt này');
      return;
    }

    const actor = await this.prisma.user.findFirst({
      where: { email: 'admin@local.dev', active: true },
      select: { id: true },
    });
    if (!actor) {
      this.logger.warn('Cron TikTok: không tìm thấy admin@local.dev');
      return;
    }

    this.tiktokRunning = true;
    try {
      const r = await this.tiktokOrders.syncRecent(
        TIKTOK_WINDOW_MINUTES,
        actor.id,
      );
      if (r.fetched) {
        this.logger.log(
          `Cron TikTok: ${r.fetched} đơn thay đổi trong ${TIKTOK_WINDOW_MINUTES} phút — ${r.created} mới, ${r.updated} cập nhật`,
        );
      }
    } catch (e) {
      this.logger.error(
        `Cron TikTok thất bại: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.tiktokRunning = false;
    }
  }

  @Cron(process.env.CHANNEL_SYNC_CRON ?? CronExpression.EVERY_10_MINUTES)
  async pollPendingOrders() {
    if (process.env.CHANNEL_SYNC_CRON_ENABLED !== 'true') return;

    const admin = await this.prisma.user.findFirst({
      where: { email: 'admin@local.dev', active: true },
    });
    if (!admin) {
      this.logger.warn('Channel sync cron: admin@local.dev not found');
      return;
    }

    const user: AuthUser = {
      userId: admin.id,
      email: admin.email,
      roles: [UserRole.admin],
      locationIds: [],
    };

    try {
      const result = await this.sync.syncConnectedChannels(user);
      this.logger.log(
        `Channel sync cron: synced ${result.synced}/${result.results.length}`,
      );
    } catch (e) {
      this.logger.error(
        'Channel sync cron failed',
        e instanceof Error ? e.stack : e,
      );
    }
  }
}
