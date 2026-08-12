import { Injectable } from '@nestjs/common';
import { InventoryBucket, MovementType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { InsufficientStockException } from '../../common/exceptions/business.exception';
import { InventoryRepository } from './inventory.repository';
import {
  ApplyMovementInput,
  computeAvailable,
  getBucketValue,
  setBucketValue,
  LevelState,
} from './inventory.types';

/**
 * FOR UPDATE xếp hàng chờ khi nhiều giao dịch tranh cùng một dòng tồn — thời
 * gian chờ khóa tính vào timeout của transaction, nên mặc định 5s của Prisma
 * quá ngắn khi hàng đợi dài (bị hủy với P2028 dù không có gì sai).
 */
const MOVEMENT_TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

/**
 * Các bước trong vòng đời đơn hàng được phép giữ chỗ/di chuyển vượt tồn thực
 * tế (bán âm/backorder giống Sapo) — cảnh báo "Hết hàng" ở giao diện thay vì
 * chặn cứng lúc đặt/đóng gói/xuất đơn. Tồn vật lý (on_hand) tự nó không bao
 * giờ được âm (vẫn chặn ở nhánh riêng bên dưới); việc kiểm tra đủ hàng thật
 * trước khi bàn giao cho ĐTVC chuyển sang FulfillmentService.pushShipment().
 * Các module khác (nhập/chuyển/trả hàng...) không nằm trong danh sách này
 * nên vẫn bị chặn âm tồn như cũ.
 */
const ORDER_LIFECYCLE_TYPES: ReadonlySet<MovementType> = new Set([
  MovementType.order_reserve,
  MovementType.order_release,
  MovementType.packing_start,
  MovementType.packing_cancel,
  MovementType.order_ship,
]);

@Injectable()
export class InventoryService {
  constructor(
    private prisma: PrismaService,
    private repo: InventoryRepository,
  ) {}

  /** Một điểm vào duy nhất thay đổi tồn (Nguyên tắc III) */
  applyMovement(input: ApplyMovementInput, tx?: Prisma.TransactionClient) {
    if (tx) {
      return this.applyMovementsInternal(tx, [input]);
    }
    return this.prisma.$transaction(
      (client) => this.applyMovementsInternal(client, [input]),
      MOVEMENT_TX_OPTIONS,
    );
  }

  applyMovements(inputs: ApplyMovementInput[], tx?: Prisma.TransactionClient) {
    if (tx) {
      return this.applyMovementsInternal(tx, inputs);
    }
    return this.prisma.$transaction(
      (client) => this.applyMovementsInternal(client, inputs),
      MOVEMENT_TX_OPTIONS,
    );
  }

  /**
   * Đặt on_hand về đúng giá trị đích (điều chỉnh kiểu "set", dùng cho import).
   * Khóa dòng tồn TRƯỚC khi tính delta nên số liệu không thể bị giao dịch khác
   * chen vào giữa lúc đọc và lúc ghi. Trả về null nếu tồn đã đúng giá trị đích.
   */
  adjustOnHandTo(
    input: {
      variantId: bigint;
      locationId: bigint;
      targetOnHand: number;
      referenceType?: string;
      referenceId?: bigint;
      createdById?: bigint;
    },
    tx?: Prisma.TransactionClient,
  ) {
    const run = async (client: Prisma.TransactionClient) => {
      await this.ensureLevelLocked(client, input.variantId, input.locationId);
      const level = await this.getLevelState(
        client,
        input.variantId,
        input.locationId,
      );
      const change = input.targetOnHand - level.onHand;
      if (change === 0) return null;
      return this.applyMovementsInternal(client, [
        {
          variantId: input.variantId,
          locationId: input.locationId,
          bucket: InventoryBucket.on_hand,
          change,
          type: MovementType.adjust,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          createdById: input.createdById,
        },
      ]);
    };
    if (tx) return run(tx);
    return this.prisma.$transaction(run, MOVEMENT_TX_OPTIONS);
  }

  private async applyMovementsInternal(
    tx: Prisma.TransactionClient,
    inputs: ApplyMovementInput[],
  ): Promise<{
    movementIds: bigint[];
    level: Awaited<
      ReturnType<
        Prisma.TransactionClient['inventoryLevel']['findUniqueOrThrow']
      >
    >;
  }> {
    if (!inputs.length) {
      throw new Error('applyMovementsInternal requires at least one input');
    }

    const { variantId, locationId } = inputs[0];
    await this.ensureLevelLocked(tx, variantId, locationId);

    const movementIds: bigint[] = [];

    for (const input of inputs) {
      if (input.variantId !== variantId || input.locationId !== locationId) {
        throw new Error(
          'Batch movements must share variant_id and location_id',
        );
      }

      const level = await this.getLevelState(tx, variantId, locationId);
      const current = getBucketValue(level, input.bucket);
      const next = current + input.change;

      if (next < 0) {
        if (input.bucket === InventoryBucket.on_hand) {
          const wouldAvailable = computeAvailable({
            onHand: next,
            committed: level.committed,
            packed: level.packed,
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

      // Bucket on_hand kéo available lên khi tăng; committed/packed (giữ chỗ)
      // kéo available xuống khi tăng — dùng để biết đúng chiều tác động.
      // incoming không nằm trong computeAvailable() nên không bao giờ "làm
      // xấu thêm" available — loại trừ để duyệt PO nhập hàng không bị chặn
      // nhầm khi available đã âm sẵn vì lý do khác (đơn bán backorder...).
      const worsensAvailable =
        input.bucket === InventoryBucket.on_hand
          ? input.change < 0
          : input.bucket !== InventoryBucket.incoming && input.change > 0;

      if (
        available < 0 &&
        worsensAvailable &&
        input.bucket !== InventoryBucket.unavailable &&
        !ORDER_LIFECYCLE_TYPES.has(input.type)
      ) {
        throw new InsufficientStockException();
      }

      await this.repo.updateLevel(tx, variantId, locationId, {
        ...level,
        available,
        ...(input.price !== undefined ? { price: input.price } : {}),
        ...(input.cost !== undefined ? { cost: input.cost } : {}),
      });

      const movement = await this.repo.insertMovement(tx, input);
      movementIds.push(movement.id);
    }

    const finalLevel = await tx.inventoryLevel.findUniqueOrThrow({
      where: { variantId_locationId: { variantId, locationId } },
    });

    return { movementIds, level: finalLevel };
  }

  private async ensureLevelLocked(
    tx: Prisma.TransactionClient,
    variantId: bigint,
    locationId: bigint,
  ) {
    const locked = await this.repo.lockLevel(tx, variantId, locationId);
    if (!locked.length) {
      await this.repo.createLevel(tx, variantId, locationId);
      await this.repo.lockLevel(tx, variantId, locationId);
    }
  }

  private async getLevelState(
    tx: Prisma.TransactionClient,
    variantId: bigint,
    locationId: bigint,
  ): Promise<LevelState> {
    const row = await tx.inventoryLevel.findUniqueOrThrow({
      where: { variantId_locationId: { variantId, locationId } },
    });
    return {
      onHand: row.onHand,
      committed: row.committed,
      packed: row.packed,
      unavailable: row.unavailable,
      incoming: row.incoming,
    };
  }

  /** Đối soát INV-2a/2b */
  async reconcile(variantId: bigint, locationId: bigint) {
    const level = await this.prisma.inventoryLevel.findUnique({
      where: { variantId_locationId: { variantId, locationId } },
    });
    if (!level) return { ok: true, buckets: {} };

    const buckets: InventoryBucket[] = [
      InventoryBucket.on_hand,
      InventoryBucket.committed,
      InventoryBucket.packed,
      InventoryBucket.unavailable,
      InventoryBucket.incoming,
    ];

    const fieldMap: Record<InventoryBucket, keyof typeof level> = {
      on_hand: 'onHand',
      available: 'available',
      committed: 'committed',
      packed: 'packed',
      reserved: 'reserved',
      unavailable: 'unavailable',
      incoming: 'incoming',
    };

    const result: Record<
      string,
      { expected: number; ledger: number; ok: boolean }
    > = {};

    for (const bucket of buckets) {
      const agg = await this.prisma.inventoryMovement.aggregate({
        where: { variantId, locationId, bucket },
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
        packed: level.packed,
        unavailable: level.unavailable,
      });

    return {
      ok: inv1Ok && Object.values(result).every((r) => r.ok),
      available_formula_ok: inv1Ok,
      buckets: result,
    };
  }
}
