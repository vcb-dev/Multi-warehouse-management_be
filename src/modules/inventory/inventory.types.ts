import {
  InventoryBucket,
  MovementType,
  Prisma,
} from '@prisma/client';

export type ApplyMovementInput = {
  variantId: bigint;
  locationId: bigint;
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
  locationId: bigint;
  onHand: number;
  committed: number;
  packed: number;
  unavailable: number;
  incoming: number;
  available: number;
};

export type LevelState = {
  onHand: number;
  committed: number;
  packed: number;
  unavailable: number;
  incoming: number;
};

/**
 * Sắp items theo (variantId, locationId) để mọi transaction khóa các dòng
 * inventory_levels theo cùng một thứ tự — hai chứng từ chứa cùng cặp biến thể
 * theo thứ tự ngược nhau sẽ không deadlock.
 */
export function sortForLocking<
  T extends { variantId: bigint; locationId?: bigint },
>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.variantId !== b.variantId) {
      return a.variantId < b.variantId ? -1 : 1;
    }
    const aw = a.locationId ?? 0n;
    const bw = b.locationId ?? 0n;
    return aw < bw ? -1 : aw > bw ? 1 : 0;
  });
}

export function computeAvailable(level: {
  onHand: number;
  committed: number;
  packed: number;
  unavailable: number;
}): number {
  return level.onHand - level.committed - level.packed - level.unavailable;
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
    case InventoryBucket.packed:
      level.packed = value;
      break;
    case InventoryBucket.unavailable:
      level.unavailable = value;
      break;
    case InventoryBucket.incoming:
      level.incoming = value;
      break;
    // `available` là số dẫn xuất (computeAvailable) và `reserved` do Sapo giữ —
    // hai bucket này không nhận bút toán trực tiếp từ nghiệp vụ nội bộ.
    case InventoryBucket.available:
    case InventoryBucket.reserved:
      break;
  }
}

export function getBucketValue(level: LevelState, bucket: InventoryBucket): number {
  switch (bucket) {
    case InventoryBucket.on_hand:
      return level.onHand;
    case InventoryBucket.committed:
      return level.committed;
    case InventoryBucket.packed:
      return level.packed;
    case InventoryBucket.unavailable:
      return level.unavailable;
    case InventoryBucket.incoming:
      return level.incoming;
    case InventoryBucket.available:
      return computeAvailable(level);
    case InventoryBucket.reserved:
      return 0;
  }
}
