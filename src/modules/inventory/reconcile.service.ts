import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from './inventory.service';

export type ReconcileReport = {
  checked: number;
  mismatches: Array<{
    variant_id: string;
    warehouse_id: string;
    ok: boolean;
    available_formula_ok?: boolean;
    buckets?: Record<string, { expected: number; ledger: number; ok: boolean }>;
  }>;
  ok: boolean;
  ran_at: string;
};

@Injectable()
export class ReconcileService {
  private readonly logger = new Logger(ReconcileService.name);

  constructor(
    private prisma: PrismaService,
    private inventory: InventoryService,
  ) {}

  /** Đối soát toàn bộ dòng inventory_levels (KC4 / INV-2) */
  async runFullReconcile(): Promise<ReconcileReport> {
    const levels = await this.prisma.inventoryLevel.findMany({
      select: { variantId: true, warehouseId: true },
    });

    const mismatches: ReconcileReport['mismatches'] = [];

    for (const level of levels) {
      const result = await this.inventory.reconcile(
        level.variantId,
        level.warehouseId,
      );
      if (!result.ok) {
        mismatches.push({
          variant_id: level.variantId.toString(),
          warehouse_id: level.warehouseId.toString(),
          ok: result.ok,
          available_formula_ok: result.available_formula_ok,
          buckets: result.buckets,
        });
      }
    }

    const report: ReconcileReport = {
      checked: levels.length,
      mismatches,
      ok: mismatches.length === 0,
      ran_at: new Date().toISOString(),
    };

    if (!report.ok) {
      this.logger.warn(
        `Đối soát sổ cái: ${mismatches.length}/${levels.length} dòng lệch`,
      );
      await this.prisma.activityLog.create({
        data: {
          action: 'inventory.reconcile.mismatch',
          entityType: 'inventory_reconcile',
          metadata: report as object,
        },
      });
    } else {
      this.logger.log(`Đối soát sổ cái OK — ${levels.length} dòng`);
    }

    return report;
  }
}
