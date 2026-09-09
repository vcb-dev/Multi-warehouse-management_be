import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { resolveChannelSyncActorId } from '../channel-sync-actor';
import { ShopeeSyncService } from './shopee-sync.service';

const SHOPEE_WINDOW_MINUTES = Number(
  process.env.SHOPEE_SYNC_WINDOW_MINUTES ?? 45,
);

@Injectable()
export class ShopeeSyncScheduler {
  private readonly logger = new Logger(ShopeeSyncScheduler.name);
  private shopeeRunning = false;

  constructor(
    private readonly shopeeSync: ShopeeSyncService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Kéo đơn Shopee định kỳ theo `update_time` — cùng mô hình cron TikTok.
   * Bật bằng `SHOPEE_SYNC_CRON_ENABLED=true` (hoặc legacy `CHANNEL_SYNC_CRON_ENABLED`).
   */
  @Cron(process.env.SHOPEE_SYNC_CRON ?? '0 */15 * * * *')
  async pollShopeeOrders() {
    if (!this.isShopeeCronEnabled()) return;
    if (this.shopeeRunning) {
      this.logger.warn('Cron Shopee: lần chạy trước chưa xong, bỏ lượt này');
      return;
    }

    const actorId = await resolveChannelSyncActorId(this.prisma);
    if (!actorId) {
      this.logger.warn(
        'Cron Shopee: không tìm thấy user đồng bộ (CHANNEL_SYNC_ACTOR_* hoặc admin active)',
      );
      return;
    }

    this.shopeeRunning = true;
    try {
      const r = await this.shopeeSync.syncRecent(
        SHOPEE_WINDOW_MINUTES,
        actorId,
      );
      if (r.fetched) {
        this.logger.log(
          `Cron Shopee: ${r.fetched} đơn thay đổi trong ${SHOPEE_WINDOW_MINUTES} phút — ${r.created} mới, ${r.updated} cập nhật`,
        );
      }
    } catch (e) {
      this.logger.error(
        `Cron Shopee thất bại: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.shopeeRunning = false;
    }
  }

  private isShopeeCronEnabled(): boolean {
    const explicit = process.env.SHOPEE_SYNC_CRON_ENABLED?.trim();
    if (explicit === 'true') return true;
    if (explicit === 'false') return false;
    return process.env.CHANNEL_SYNC_CRON_ENABLED === 'true';
  }
}
