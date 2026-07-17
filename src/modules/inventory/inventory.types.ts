import {
  InventoryBucket,
  MovementType,
  Prisma,
} from '@prisma/client';

export type ApplyMovementInput = {
  variantId: bigint;
  warehouseId: bigint;
  bucket: InventoryBucket;
  change: number;
  type: MovementType;
  referenceType?: string;
  referenceId?: bigint;
  createdById?: bigint;
  price?: Prisma.Decimal;
  cost?: Prisma.Decimal;
};

export type InventoryLevelDto = {
  variantId: bigint;
  warehouseId: bigint;
  onHand: number;
  committed: number;
  packing: number;
  unavailable: number;
  incoming: number;
  available: number;
};

export type LevelState = {
  onHand: number;
  committed: number;
  packing: number;
  unavailable: number;
  incoming: number;
};

/**
 * Sắp items theo (variantId, warehouseId) để mọi transaction khóa các dòng
 * inventory_levels theo cùng một thứ tự — hai chứng từ chứa cùng cặp biến thể
 * theo thứ tự ngược nhau sẽ không deadlock.
 */
export function sortForLocking<
  T extends { variantId: bigint; warehouseId?: bigint },
>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.variantId !== b.variantId) {
      return a.variantId < b.variantId ? -1 : 1;
    }
    const aw = a.warehouseId ?? 0n;
    const bw = b.warehouseId ?? 0n;
    return aw < bw ? -1 : aw > bw ? 1 : 0;
  });
}

export function computeAvailable(level: {
  onHand: number;
  committed: number;
  packing: number;
  unavailable: number;
}): number {
  return level.onHand - level.committed - level.packing - level.unavailable;
}

export function setBucketValue(
  level: LevelState,
  bucket: InventoryBucket,
  value: number,
): void {
  switch (bucket) {
    case InventoryBucket.on_hand:
      level.onHand = value;
      break;
    case InventoryBucket.committed:
      level.committed = value;
      break;
    case InventoryBucket.packing:
      level.packing = value;
      break;
    case InventoryBucket.unavailable:
      level.unavailable = value;
      break;
    case InventoryBucket.incoming:
      level.incoming = value;
      break;
  }
}

export function getBucketValue(level: LevelState, bucket: InventoryBucket): number {
  switch (bucket) {
    case InventoryBucket.on_hand:
      return level.onHand;
    case InventoryBucket.committed:
      return level.committed;
    case InventoryBucket.packing:
      return level.packing;
    case InventoryBucket.unavailable:
      return level.unavailable;
    case InventoryBucket.incoming:
      return level.incoming;
  }
}
