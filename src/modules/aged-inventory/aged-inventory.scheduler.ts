import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AgedInventorySnapshotService } from './aged-inventory-snapshot.service';

/**
 * 0h giờ VN mỗi ngày dựng lại snapshot trang sức tồn lâu để bên ngoài kéo qua API.
 *
 * Phải truyền `timeZone`: container Railway chạy UTC, không truyền thì "0h" thành 7h sáng.
 * Lượt chạy mất ~10 phút (quét tồn từng kho trên Sapo); trong lúc đó API vẫn trả snapshot
 * hôm trước — transaction ghi đè chỉ commit khi xong hết.
 */
const DEFAULT_CRON = '0 0 0 * * *';

@Injectable()
export class AgedInventoryScheduler {
  private readonly logger = new Logger(AgedInventoryScheduler.name);

  constructor(private readonly snapshots: AgedInventorySnapshotService) {}

  @Cron(process.env.AGED_INVENTORY_CRON ?? DEFAULT_CRON, {
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async run() {
    // Mặc định TẮT như mọi cron khác — bật bằng AGED_INVENTORY_CRON_ENABLED=true.
    if (process.env.AGED_INVENTORY_CRON_ENABLED !== 'true') return;
    if (!this.snapshots.isConfigured()) {
      this.logger.warn(
        'Cron tồn lâu: thiếu SAPO_STORE/SAPO_API_KEY/SAPO_API_SECRET',
      );
      return;
    }

    try {
      const r = await this.snapshots.runExclusive();
      if (!r) {
        this.logger.warn('Cron tồn lâu: lượt trước chưa xong, bỏ lượt này');
        return;
      }
      this.snapshots.logResult('Cron', r);
    } catch (e) {
      this.logger.error(
        `Cron tồn lâu thất bại: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
