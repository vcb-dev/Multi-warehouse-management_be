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
  lotId?: bigint;
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
