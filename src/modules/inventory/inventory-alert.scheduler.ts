import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InventoryAlertService } from './inventory-alert.service';

/**
 * 7h sáng và 14h chiều mỗi ngày — nhịp đặt hàng nhập là theo buổi, không theo giờ.
 * Quét mỗi giờ sẽ phải tính lại bán 15/30/90 ngày trên bảng `orders` (~88k dòng) cho
 * ~3.900 dòng tồn, tốn mà không đổi được quyết định gì.
 */
const DEFAULT_CRON = '0 7,14 * * *';

@Injectable()
export class InventoryAlertScheduler {
  private readonly logger = new Logger(InventoryAlertScheduler.name);
  /** Chặn hai lượt chồng nhau khi một lượt quét kéo dài quá chu kỳ. */
  private running = false;

  constructor(private readonly alerts: InventoryAlertService) {}

  @Cron(process.env.INVENTORY_ALERT_CRON ?? DEFAULT_CRON)
  async scan() {
    // Mặc định TẮT, giống mọi cron khác trong dự án — bật bằng biến môi trường để môi
    // trường dev không tự bắn thông báo vào DB thật.
    if (process.env.INVENTORY_ALERT_CRON_ENABLED !== 'true') return;
    if (this.running) {
      this.logger.warn('Cron tồn kho: lượt trước chưa xong, bỏ lượt này');
      return;
    }

    this.running = true;
    try {
      const r = await this.alerts.scanAll();
      if (r.notifications) {
        this.logger.log(
          `Cron tồn kho: quét ${r.locations} kho, sinh ${r.notifications} thông báo`,
        );
      }
    } catch (e) {
      this.logger.error(
        `Cron tồn kho thất bại: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
