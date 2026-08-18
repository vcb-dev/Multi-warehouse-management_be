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
import { TiktokReturnSyncService } from './tiktok/tiktok-return-sync.service';

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

/**
 * Số ngày quét lại của lượt tổng vệ sinh hằng ngày. Xem `sweepTiktokOrders()` về lý do
 * cần lượt này bên cạnh cron 15 phút.
 */
const TIKTOK_SWEEP_DAYS = Number(process.env.TIKTOK_SWEEP_DAYS ?? 7);

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
    private readonly tiktokReturns: TiktokReturnSyncService,
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

  /**
   * Lưới an toàn hằng ngày: quét lại {@link TIKTOK_SWEEP_DAYS} ngày theo `update_time`.
   *
   * Vì sao cần dù đã có cron 15 phút: cửa sổ của cron chỉ {@link TIKTOK_WINDOW_MINUTES}
   * phút, nên **mỗi lần server nghỉ lâu hơn thế là mất vĩnh viễn** số đơn đổi trạng thái
   * trong khoảng đó — không có gì quay lại đọc chúng nữa. Đây không phải rủi ro lý thuyết:
   * đo 2026-08-18 thấy tháng 5 và tháng 6 có **0/1.719 đơn ở trạng thái đóng**, lấy mẫu 15
   * đơn mà DB ghi "đang mở" thì TikTok trả 13 COMPLETED + 2 CANCELLED — sai 15/15.
   *
   * Chạy đêm vì tốn ~0,7 giây/đơn (7 ngày ≈ 900 đơn ≈ 10 phút) và dùng chung cờ
   * `tiktokRunning` với cron 15 phút để hai lượt không giẫm chân nhau.
   */
  @Cron(process.env.TIKTOK_SWEEP_CRON ?? '0 30 3 * * *')
  async sweepTiktokOrders() {
    if (process.env.TIKTOK_SYNC_CRON_ENABLED !== 'true') return;
    if (this.tiktokRunning) {
      this.logger.warn('Quét ngày TikTok: cron 15 phút đang chạy, bỏ lượt này');
      return;
    }

    const actorId = await resolveChannelSyncActorId(this.prisma);
    if (!actorId) {
      this.logger.warn(
        'Quét ngày TikTok: không tìm thấy user đồng bộ (CHANNEL_SYNC_ACTOR_* hoặc admin active)',
      );
      return;
    }

    this.tiktokRunning = true;
    try {
      const r = await this.tiktokOrders.syncRecent(
        TIKTOK_SWEEP_DAYS * 24 * 60,
        actorId,
      );
      this.logger.log(
        `Quét ngày TikTok (${TIKTOK_SWEEP_DAYS} ngày): ${r.fetched} đơn — ${r.created} mới, ${r.updated} cập nhật`,
      );
    } catch (e) {
      this.logger.error(
        `Quét ngày TikTok thất bại: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.tiktokRunning = false;
    }
  }

  /**
   * Phiếu hoàn/trả TikTok. Chạy thưa hơn đơn (mặc định 1 giờ) vì hoàn hàng diễn ra theo
   * ngày chứ không theo phút — khách gửi hàng về rồi chờ kho sàn nhận, không có gì gấp.
   * Cửa sổ rộng 3 giờ để các lượt chồng lấn nhau; upsert theo `order_returns.code` nên
   * quét trùng không sinh phiếu ma.
   */
  @Cron(process.env.TIKTOK_RETURN_CRON ?? CronExpression.EVERY_HOUR)
  async pollTiktokReturns() {
    if (process.env.TIKTOK_SYNC_CRON_ENABLED !== 'true') return;

    const actorId = await resolveChannelSyncActorId(this.prisma);
    if (!actorId) return;

    try {
      const r = await this.tiktokReturns.syncRecent(180, actorId);
      if (r.fetched) {
        this.logger.log(
          `Cron hoàn hàng TikTok: ${r.fetched} phiếu — ${r.orders_updated} đơn đổi trạng thái`,
        );
      }
    } catch (e) {
      this.logger.error(
        `Cron hoàn hàng TikTok thất bại: ${e instanceof Error ? e.message : String(e)}`,
      );
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
