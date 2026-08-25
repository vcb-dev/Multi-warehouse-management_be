import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';
import {
  resolveChannelSyncActor,
  resolveChannelSyncActorId,
} from './channel-sync-actor';
import { ChannelSyncService } from './channel-sync.service';
import { SapoInventorySyncService } from './sapo/sapo-inventory-sync.service';
import { SapoLocationSyncService } from './sapo/sapo-location-sync.service';
import { SapoOrderSyncService } from './sapo/sapo-order-sync.service';
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
  private sapoRunning = false;
  private sapoInventoryRunning = false;
  private sapoLocationRunning = false;

  constructor(
    private readonly sync: ChannelSyncService,
    private readonly tiktokOrders: TiktokOrderSyncService,
    private readonly shopeeSync: ShopeeSyncService,
    private readonly tiktokReturns: TiktokReturnSyncService,
    private readonly sapoOrders: SapoOrderSyncService,
    private readonly sapoInventory: SapoInventorySyncService,
    private readonly sapoLocations: SapoLocationSyncService,
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  /**
   * Đồng bộ danh sách kho từ Sapo — **2h50 sáng thứ Bảy**, tức 10 phút TRƯỚC cron đơn.
   *
   * Thứ tự này là điều kiện đúng đắn của cả buổi sáng: kho mới phải có trong `locations`
   * trước khi đơn của nó về, nếu không đơn bị gán tạm vào kho mặc định và mọi báo cáo theo
   * kho lệch cho tới khi có người sửa tay từng đơn.
   */
  @Cron(process.env.SAPO_LOCATION_SYNC_CRON ?? '0 50 2 * * 6')
  async pollSapoLocations() {
    if (process.env.SAPO_LOCATION_SYNC_CRON_ENABLED !== 'true') return;
    if (!this.sapoLocations.isConfigured()) {
      this.logger.warn(
        'Cron kho Sapo: thiếu SAPO_STORE/SAPO_API_KEY/SAPO_API_SECRET',
      );
      return;
    }
    if (this.sapoLocationRunning) {
      this.logger.warn('Cron kho Sapo: lần chạy trước chưa xong, bỏ lượt này');
      return;
    }

    this.sapoLocationRunning = true;
    try {
      const r = await this.sapoLocations.syncLocations();
      this.logger.log(
        `Cron kho Sapo: ${r.fetched} kho trên Sapo — ${r.created} thêm mới, ` +
          `${r.updated} cập nhật, ${r.unchanged} không đổi, ` +
          `${r.missing_in_sapo.length} kho DB có mà Sapo không trả, ` +
          `${r.code_conflicts.length} mã kho trùng`,
      );
    } catch (e) {
      this.logger.error(
        `Cron kho Sapo thất bại: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.sapoLocationRunning = false;
    }
  }

  /**
   * Kéo đơn mới từ Sapo.
   *
   * Vì sao cần dù đã có cron TikTok/Shopee: hai cron kia chỉ lấy đơn của đúng hai sàn đó.
   * Đơn POS, đơn web, đơn chat OmniAI (facebook/zalo-oa/tiktok-for-business) và mọi kênh
   * còn lại chỉ tồn tại phía Sapo — trước đây chúng chỉ về DB khi có người chạy tay
   * `scripts/sync-new-sapo-orders.ts`.
   *
   * Quét theo `created_on` chứ không phải `modified_on`: lượt này chỉ TẠO đơn mới, không
   * cập nhật đơn cũ, nên lọc theo ngày sửa chỉ tốn thêm băng thông cho những đơn rồi cũng
   * bị bỏ qua vì đã có `sapo_id` trong DB.
   *
   * Nhịp: **3h00 sáng thứ Bảy hằng tuần**, không phải mỗi nửa tiếng. Chạy được theo nhịp
   * thưa vì mốc quét lấy từ đơn Sapo mới nhất trong DB (lùi `SAPO_ORDER_SYNC_OVERLAP_MINUTES`)
   * chứ không phải cửa sổ cố định — một lượt tự vét trọn tuần vừa qua.
   *
   * Hai hệ quả của nhịp tuần, chấp nhận có chủ đích:
   * - Phần lớn đơn về sẽ quá `SYNC_NOTIFY_MAX_AGE_HOURS` (24h) nên KHÔNG bắn thông báo —
   *   đúng ý: chuông báo đơn mới chỉ có nghĩa với đơn vừa phát sinh.
   * - Một tuần đơn phải lọt trong `SAPO_ORDER_SYNC_MAX_PAGES` × 250 (mặc định 10.000 đơn).
   *   Vượt trần thì log cảnh báo, nới biến đó hoặc chạy tay `POST channels/sapo/sync`.
   */
  @Cron(process.env.SAPO_ORDER_SYNC_CRON ?? '0 0 3 * * 6')
  async pollSapoOrders() {
    if (process.env.SAPO_ORDER_SYNC_CRON_ENABLED !== 'true') return;
    if (!this.sapoOrders.isConfigured()) {
      this.logger.warn(
        'Cron đơn Sapo: thiếu SAPO_STORE/SAPO_API_KEY/SAPO_API_SECRET',
      );
      return;
    }
    if (this.sapoRunning) {
      this.logger.warn('Cron đơn Sapo: lần chạy trước chưa xong, bỏ lượt này');
      return;
    }

    this.sapoRunning = true;
    try {
      const r = await this.sapoOrders.syncNewOrders();
      if (r.created || r.failed || r.skipped_lines_no_variant) {
        this.logger.log(
          `Cron đơn Sapo (từ ${r.since}): ${r.fetched} đơn quét — ${r.created} tạo mới, ` +
            `${r.reserved} giữ chỗ tồn, ${r.skipped_existing} đã có, ` +
            `${r.skipped_lines_no_variant} dòng thiếu phiên bản, ${r.failed} lỗi`,
        );
      }
    } catch (e) {
      this.logger.error(
        `Cron đơn Sapo thất bại: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.sapoRunning = false;
    }
  }

  /**
   * Kéo lại tồn kho từ Sapo — **3h40 sáng thứ Bảy hằng tuần**.
   *
   * Chạy SAU cron đơn (3h00) và cron sản phẩm (3h20) trong cùng buổi sáng, có chủ đích:
   * phiên bản mới phải có `inventory_item_id` (do cron sản phẩm mang về) thì lượt này mới
   * hỏi được tồn của nó, và tồn là thứ chốt cuối nên phải lấy sau khi đơn đã vào.
   *
   * Cảnh báo cần biết trước khi bật: lượt này coi **Sapo là nguồn chân lý và ghi đè cả
   * `committed`**, nên phần giữ chỗ do chính app tạo ra (đơn app tự tạo, phiếu chuyển kho
   * đang chờ) sẽ bị thay bằng con số của Sapo. Chỉ hợp khi Sapo vẫn là nơi chốt tồn thật;
   * nếu app trở thành nguồn chân lý thì phải tắt cron này đi.
   */
  @Cron(process.env.SAPO_INVENTORY_SYNC_CRON ?? '0 40 3 * * 6')
  async pollSapoInventory() {
    if (process.env.SAPO_INVENTORY_SYNC_CRON_ENABLED !== 'true') return;
    if (!this.sapoInventory.isConfigured()) {
      this.logger.warn(
        'Cron tồn kho Sapo: thiếu SAPO_STORE/SAPO_API_KEY/SAPO_API_SECRET',
      );
      return;
    }
    if (this.sapoInventoryRunning) {
      this.logger.warn(
        'Cron tồn kho Sapo: lần chạy trước chưa xong, bỏ lượt này',
      );
      return;
    }

    this.sapoInventoryRunning = true;
    try {
      const r = await this.sapoInventory.syncInventoryLevels();
      this.logger.log(
        `Cron tồn kho Sapo: ${r.scanned} dòng quét — ${r.created} tạo mới, ${r.updated} cập nhật, ` +
          `${r.already_correct} đã đúng, ${r.movements} bút toán bù; ` +
          `${r.unmatched_items} item lạ, ${r.unmatched_locations} kho lạ, ` +
          `${r.local_only} dòng Sapo không trả (giữ nguyên), ` +
          `${r.variants_without_item_id} phiên bản thiếu inventory_item_id`,
      );
    } catch (e) {
      this.logger.error(
        `Cron tồn kho Sapo thất bại: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.sapoInventoryRunning = false;
    }
  }

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
