import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ReconcileService } from './reconcile.service';

/** Job đối soát sổ cái định kỳ — bật bằng RECONCILE_INTERVAL_MS (>0) */
@Injectable()
export class ReconcileScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconcileScheduler.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(private reconcile: ReconcileService) {}

  onModuleInit() {
    const intervalMs = Number(process.env.RECONCILE_INTERVAL_MS ?? 0);
    if (!intervalMs || intervalMs <= 0) return;

    this.logger.log(`Lên lịch đối soát sổ cái mỗi ${intervalMs}ms`);
    this.timer = setInterval(() => {
      void this.reconcile.runFullReconcile().catch((err) => {
        this.logger.error('Job đối soát thất bại', err);
      });
    }, intervalMs);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
