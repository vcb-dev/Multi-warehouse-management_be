import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

type LogCtx = {
  tx: Prisma.TransactionClient;
  variantId: bigint;
  field: 'price' | 'cost';
  oldValue: Prisma.Decimal | number | null;
  newValue: Prisma.Decimal | number;
  changedById?: bigint;
  source?: 'manual' | 'import' | 'create';
};

@Injectable()
export class VariantPriceHistoryService {
  /** Chỉ ghi khi số thực sự khác nhau */
  async logIfChanged(ctx: LogCtx): Promise<void> {
    const oldNum = ctx.oldValue == null ? null : Number(ctx.oldValue);
    const newNum = Number(ctx.newValue);
    if (oldNum === newNum) return;

    await ctx.tx.variantPriceHistory.create({
      data: {
        variantId: ctx.variantId,
        field: ctx.field,
        oldValue: oldNum,
        newValue: newNum,
        source: ctx.source ?? 'manual',
        changedById: ctx.changedById,
      },
    });
  }
}
