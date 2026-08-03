import { Injectable, Logger } from '@nestjs/common';
import { InventoryBucket } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { computeAvailable } from './inventory.types';

/** Số dòng lệch tối đa ghi vào activity_logs — báo cáo trả về vẫn đầy đủ. */
const MAX_LOGGED_MISMATCHES = 100;

/** Bồn có sổ cái đối ứng — `available` là số dẫn xuất, `reserved` do Sapo giữ. */
const LEDGER_BUCKETS = [
  InventoryBucket.on_hand,
  InventoryBucket.committed,
  InventoryBucket.packed,
  InventoryBucket.unavailable,
  InventoryBucket.incoming,
] as const;

const LEVEL_FIELD: Record<(typeof LEDGER_BUCKETS)[number], string> = {
  on_hand: 'onHand',
  committed: 'committed',
  packed: 'packed',
  unavailable: 'unavailable',
  incoming: 'incoming',
};

export type ReconcileReport = {
  checked: number;
  mismatches: Array<{
    variant_id: string;
    location_id: string;
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

  constructor(private prisma: PrismaService) {}

  /**
   * Đối soát toàn bộ dòng inventory_levels (KC4 / INV-2).
   *
   * Gộp sổ cái bằng MỘT `groupBy` thay vì quét từng dòng: bản cũ chạy 5 lệnh
   * `aggregate` cho mỗi dòng tồn, với 15k dòng là ~76k lượt round-trip tuần tự
   * nên endpoint không bao giờ trả về.
   */
  async runFullReconcile(): Promise<ReconcileReport> {
    const levels = await this.prisma.inventoryLevel.findMany({
      select: {
        variantId: true,
        locationId: true,
        onHand: true,
        available: true,
        committed: true,
        packed: true,
        unavailable: true,
        incoming: true,
      },
    });

    const sums = await this.prisma.inventoryMovement.groupBy({
      by: ['variantId', 'locationId', 'bucket'],
      _sum: { change: true },
    });

    const key = (variantId: bigint, locationId: bigint, bucket: string) =>
      `${variantId}:${locationId}:${bucket}`;
    const ledger = new Map<string, number>();
    for (const s of sums) {
      ledger.set(key(s.variantId, s.locationId, s.bucket), s._sum.change ?? 0);
    }

    const mismatches: ReconcileReport['mismatches'] = [];

    for (const level of levels) {
      const buckets: Record<
        string,
        { expected: number; ledger: number; ok: boolean }
      > = {};
      let bucketsOk = true;

      for (const bucket of LEDGER_BUCKETS) {
        const expected = level[
          LEVEL_FIELD[bucket] as keyof typeof level
        ] as number;
        const actual =
          ledger.get(key(level.variantId, level.locationId, bucket)) ?? 0;
        const ok = expected === actual;
        if (!ok) bucketsOk = false;
        buckets[bucket] = { expected, ledger: actual, ok };
      }

      const availableFormulaOk =
        level.available ===
        computeAvailable({
          onHand: level.onHand,
          committed: level.committed,
          packed: level.packed,
          unavailable: level.unavailable,
        });

      if (!bucketsOk || !availableFormulaOk) {
        mismatches.push({
          variant_id: level.variantId.toString(),
          location_id: level.locationId.toString(),
          ok: false,
          available_formula_ok: availableFormulaOk,
          buckets,
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
      // Ghi bản rút gọn: toàn bộ mismatch có thể lên hàng nghìn dòng, nhét cả
      // vào một ô JSON sẽ phình activity_logs sau mỗi lần chạy.
      await this.prisma.activityLog.create({
        data: {
          action: 'inventory.reconcile.mismatch',
          entityType: 'inventory_reconcile',
          metadata: {
            checked: report.checked,
            mismatch_count: mismatches.length,
            truncated: mismatches.length > MAX_LOGGED_MISMATCHES,
            mismatches: mismatches.slice(0, MAX_LOGGED_MISMATCHES),
            ran_at: report.ran_at,
          } as object,
        },
      });
    } else {
      this.logger.log(`Đối soát sổ cái OK — ${levels.length} dòng`);
    }

    return report;
  }
}
