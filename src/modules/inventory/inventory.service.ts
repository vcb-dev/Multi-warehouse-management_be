import { Injectable } from '@nestjs/common';
import { InventoryBucket, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { InsufficientStockException } from '../../common/exceptions/business.exception';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { assertWarehouseAccess as assertUserWarehouseAccess } from '../../common/auth/access';
import { InventoryRepository } from './inventory.repository';
import {
  ApplyMovementInput,
  computeAvailable,
  getBucketValue,
  setBucketValue,
  LevelState,
} from './inventory.types';

@Injectable()
export class InventoryService {
  constructor(
    private prisma: PrismaService,
    private repo: InventoryRepository,
  ) {}

  assertWarehouseAccess(user: AuthUser, warehouseId: bigint): void {
    assertUserWarehouseAccess(user, warehouseId);
  }

  /** Một điểm vào duy nhất thay đổi tồn (Nguyên tắc III) */
  applyMovement(input: ApplyMovementInput, tx?: Prisma.TransactionClient) {
    if (tx) {
      return this.applyMovementsInternal(tx, [input]);
    }
    return this.prisma.$transaction((client) =>
      this.applyMovementsInternal(client, [input]),
    );
  }

  applyMovements(inputs: ApplyMovementInput[], tx?: Prisma.TransactionClient) {
    if (tx) {
      return this.applyMovementsInternal(tx, inputs);
    }
    return this.prisma.$transaction((client) =>
      this.applyMovementsInternal(client, inputs),
    );
  }

  private async applyMovementsInternal(
    tx: Prisma.TransactionClient,
    inputs: ApplyMovementInput[],
  ): Promise<{ movementIds: bigint[]; level: Awaited<ReturnType<Prisma.TransactionClient['inventoryLevel']['findUniqueOrThrow']>> }> {
    if (!inputs.length) {
      throw new Error('applyMovementsInternal requires at least one input');
    }

    const { variantId, warehouseId } = inputs[0];
    await this.ensureLevelLocked(tx, variantId, warehouseId);

    const movementIds: bigint[] = [];

    for (const input of inputs) {
      if (
        input.variantId !== variantId ||
        input.warehouseId !== warehouseId
      ) {
        throw new Error('Batch movements must share variant_id and warehouse_id');
      }

      const level = await this.getLevelState(tx, variantId, warehouseId);
      const current = getBucketValue(level, input.bucket);
      const next = current + input.change;

      if (next < 0) {
        if (input.bucket === InventoryBucket.on_hand) {
          const wouldAvailable = computeAvailable({
            onHand: next,
            committed: level.committed,
            packing: level.packing,
            unavailable: level.unavailable,
          });
          if (wouldAvailable < 0 && input.type !== 'adjust') {
            throw new InsufficientStockException();
          }
        } else {
          throw new InsufficientStockException(
            `Không đủ ${input.bucket} (cần ${Math.abs(input.change)}, có ${current})`,
          );
        }
      }

      setBucketValue(level, input.bucket, next);

      const available = computeAvailable(level);

      if (available < 0 && input.bucket !== InventoryBucket.unavailable) {
        throw new InsufficientStockException();
      }

      await this.repo.updateLevel(tx, variantId, warehouseId, {
        ...level,
        available,
        ...(input.price !== undefined ? { price: input.price } : {}),
        ...(input.cost !== undefined ? { cost: input.cost } : {}),
      });

      const movement = await this.repo.insertMovement(tx, input);
      movementIds.push(movement.id);
    }

    const finalLevel = await tx.inventoryLevel.findUniqueOrThrow({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });

    return { movementIds, level: finalLevel };
  }

  private async ensureLevelLocked(
    tx: Prisma.TransactionClient,
    variantId: bigint,
    warehouseId: bigint,
  ) {
    const locked = await this.repo.lockLevel(tx, variantId, warehouseId);
    if (!locked.length) {
      await this.repo.createLevel(tx, variantId, warehouseId);
      await this.repo.lockLevel(tx, variantId, warehouseId);
    }
  }

  private async getLevelState(
    tx: Prisma.TransactionClient,
    variantId: bigint,
    warehouseId: bigint,
  ): Promise<LevelState> {
    const row = await tx.inventoryLevel.findUniqueOrThrow({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    return {
      onHand: row.onHand,
      committed: row.committed,
      packing: row.packing,
      unavailable: row.unavailable,
      incoming: row.incoming,
    };
  }

  /** Đối soát INV-2a/2b */
  async reconcile(variantId: bigint, warehouseId: bigint) {
    const level = await this.prisma.inventoryLevel.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    if (!level) return { ok: true, buckets: {} };

    const buckets: InventoryBucket[] = [
      InventoryBucket.on_hand,
      InventoryBucket.committed,
      InventoryBucket.packing,
      InventoryBucket.unavailable,
      InventoryBucket.incoming,
    ];

    const fieldMap: Record<InventoryBucket, keyof typeof level> = {
      on_hand: 'onHand',
      committed: 'committed',
      packing: 'packing',
      unavailable: 'unavailable',
      incoming: 'incoming',
    };

    const result: Record<string, { expected: number; ledger: number; ok: boolean }> =
      {};

    for (const bucket of buckets) {
      const agg = await this.prisma.inventoryMovement.aggregate({
        where: { variantId, warehouseId, bucket },
        _sum: { change: true },
      });
      const ledger = agg._sum.change ?? 0;
      const key = fieldMap[bucket];
      const expected = level[key] as number;
      result[bucket] = { expected, ledger, ok: expected === ledger };
    }

    const inv1Ok =
      level.available ===
      computeAvailable({
        onHand: level.onHand,
        committed: level.committed,
        packing: level.packing,
        unavailable: level.unavailable,
      });

    return {
      ok: inv1Ok && Object.values(result).every((r) => r.ok),
      available_formula_ok: inv1Ok,
      buckets: result,
    };
  }
}
