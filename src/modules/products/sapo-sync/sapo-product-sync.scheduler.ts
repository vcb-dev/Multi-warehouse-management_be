import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SapoClient } from './sapo-client';
import { SapoProductSyncService } from './sapo-product-sync.service';

/**
 * Quét TOÀN BỘ catalog 1 lần/ngày (giờ thấp điểm) — không quét theo cửa sổ
 * ngắn kiểu TikTok/Shopee. Đã đo thực tế (21/08/2026): Sapo bump `modified_on`
 * trên gần như toàn bộ sản phẩm mỗi vài chục phút vì tồn kho biến động theo
 * đơn hàng, nên lọc `updated_at_min` không thu hẹp được gì — quét "20 phút
 * gần nhất" từng trả về 12.387/12.400 sản phẩm, tức chạy 20 phút/lần chỉ tổ
 * quét đi quét lại toàn bộ catalog liên tục, vô nghĩa và tốn API.
 * `SapoProductSyncService.syncAll()` tự so sánh trước khi ghi nên một lượt
 * quét đầy đủ vẫn rẻ (99% sản phẩm không đổi gì, chỉ so sánh không ghi DB).
 */
@Injectable()
export class SapoProductSyncScheduler {
  private readonly logger = new Logger(SapoProductSyncScheduler.name);
  /** Chặn hai lần chạy chồng nhau khi một lần quét kéo dài quá chu kỳ cron. */
  private running = false;

  constructor(
    private readonly sync: SapoProductSyncService,
    private readonly sapo: SapoClient,
  ) {}

  /**
   * Mặc định TẮT — bật bằng `SAPO_PRODUCT_SYNC_CRON_ENABLED=true`, giống mọi
   * cron khác trong dự án, để môi trường dev không tự ghi vào DB thật.
   *
   * Nhịp: **3h20 sáng thứ Bảy hằng tuần** (trước đây chạy hằng ngày). Lệch 20 phút so với
   * cron đơn Sapo để hai lượt không cùng lúc chiếm connection pool.
   */
  @Cron(process.env.SAPO_PRODUCT_SYNC_CRON ?? '0 20 3 * * 6')
  async run() {
    if (process.env.SAPO_PRODUCT_SYNC_CRON_ENABLED !== 'true') return;
    if (!this.sapo.isConfigured()) {
      this.logger.warn(
        'Cron đồng bộ sản phẩm Sapo: thiếu SAPO_STORE/SAPO_API_KEY/SAPO_API_SECRET',
      );
      return;
    }
    if (this.running) {
      this.logger.warn(
        'Cron đồng bộ sản phẩm Sapo: lượt trước chưa xong, bỏ lượt này',
      );
      return;
    }

    this.running = true;
    const startedAt = Date.now();
    try {
      const r = await this.sync.syncAll();
      const secs = ((Date.now() - startedAt) / 1000).toFixed(0);
      this.logger.log(
        `Cron đồng bộ sản phẩm Sapo (${secs}s): ${r.productsSeen} SP quét — ` +
          `${r.productsCreated} mới, ${r.productsUpdated} cập nhật, ` +
          `${r.variantsCreated} phiên bản mới, ${r.variantsUpdated} phiên bản cập nhật, ` +
          `${r.imagesResynced} SP đổi ảnh, ${r.optionsCreated} SP thêm tuỳ chọn` +
          (r.skuConflicts || r.aliasConflicts
            ? ` — ⚠ ${r.skuConflicts} xung đột SKU, ${r.aliasConflicts} xung đột alias (cần soát tay)`
            : '') +
          (r.errors ? ` — ${r.errors} lỗi` : ''),
      );
    } catch (e) {
      this.logger.error(
        `Cron đồng bộ sản phẩm Sapo thất bại: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
