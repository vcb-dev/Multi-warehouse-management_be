import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';
import {
  resolveChannelSyncActor,
  resolveChannelSyncActorId,
} from './channel-sync-actor';
import { ChannelSyncService } from './channel-sync.service';
import { ShopeeSyncService } from './shopee/shopee-sync.service';
import { TiktokOrderSyncService } from './tiktok/tiktok-order-sync.service';

/**
 * Cửa sổ quét của cron TikTok, tính bằng phút. Phải RỘNG HƠN chu kỳ chạy để hai lần quét
 * chồng lấn: sync là idempotent (upsert theo `orders.name`) nên quét trùng vô hại, còn
 * quét hụt vì lệch giờ hoặc một lần chạy lỗi thì đơn mất luôn.
 */
const TIKTOK_WINDOW_MINUTES = Number(
  process.env.TIKTOK_SYNC_WINDOW_MINUTES ?? 30,
);

const SHOPEE_WINDOW_MINUTES = Number(
  process.env.SHOPEE_SYNC_WINDOW_MINUTES ?? 45,
);

@Injectable()
export class ChannelSyncScheduler {
  private readonly logger = new Logger(ChannelSyncScheduler.name);
  /** Chặn hai lần chạy chồng nhau khi một lần quét kéo dài quá chu kỳ cron. */
  private tiktokRunning = false;
  private shopeeRunning = false;

  constructor(
    private readonly sync: ChannelSyncService,
    private readonly tiktokOrders: TiktokOrderSyncService,
    private readonly shopeeSync: ShopeeSyncService,
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
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

    const actorId = await resolveChannelSyncActorId(this.prisma);
    if (!actorId) {
      this.logger.warn(
        'Cron TikTok: không tìm thấy user đồng bộ (CHANNEL_SYNC_ACTOR_* hoặc admin active)',
      );
      return;
    }

    this.tiktokRunning = true;
    try {
      const r = await this.tiktokOrders.syncRecent(
        TIKTOK_WINDOW_MINUTES,
        actorId,
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

  /** Queue file/env — không kéo Shopee (Shopee có cron riêng). */
  @Cron(process.env.CHANNEL_SYNC_CRON ?? CronExpression.EVERY_10_MINUTES)
  async pollPendingOrders() {
    if (process.env.CHANNEL_SYNC_CRON_ENABLED !== 'true') return;

    const user = await resolveChannelSyncActor(this.prisma, this.rbac);
    if (!user) {
      this.logger.warn('Channel queue cron: không tìm thấy user đồng bộ');
      return;
    }

    try {
      const result = await this.sync.syncPendingOrders(user);
      if (result.synced || result.results.length) {
        this.logger.log(
          `Channel queue cron: synced ${result.synced}/${result.results.length}`,
        );
      }
    } catch (e) {
      this.logger.error(
        'Channel queue cron failed',
        e instanceof Error ? e.stack : e,
      );
    }
  }

  private isShopeeCronEnabled(): boolean {
    const explicit = process.env.SHOPEE_SYNC_CRON_ENABLED?.trim();
    if (explicit === 'true') return true;
    if (explicit === 'false') return false;
    return process.env.CHANNEL_SYNC_CRON_ENABLED === 'true';
  }
}
