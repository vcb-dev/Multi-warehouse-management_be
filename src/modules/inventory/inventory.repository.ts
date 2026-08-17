import { Injectable } from '@nestjs/common';
import { InventoryBucket, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ApplyMovementInput } from './inventory.types';

@Injectable()
export class InventoryRepository {
  constructor(private prisma: PrismaService) {}

  lockLevel(
    tx: Prisma.TransactionClient,
    variantId: bigint,
    locationId: bigint,
  ) {
    return tx.$queryRaw<
      Array<{
        variant_id: bigint;
        location_id: bigint;
        on_hand: number;
        committed: number;
        packed: number;
        unavailable: number;
        incoming: number;
        available: number;
      }>
    >`
      SELECT variant_id, location_id, on_hand, committed, packed, unavailable, incoming, available
      FROM inventory_levels
      WHERE variant_id = ${variantId} AND location_id = ${locationId}
      FOR UPDATE
    `;
  }

  // createMany + skipDuplicates sinh INSERT ... ON CONFLICT DO NOTHING:
  // hai request đầu tiên cùng tạo dòng tồn cho một (biến thể, kho) mới
  // sẽ không đụng lỗi trùng khóa chính.
  createLevel(
    tx: Prisma.TransactionClient,
    variantId: bigint,
    locationId: bigint,
    price?: Prisma.Decimal,
    cost?: Prisma.Decimal,
  ) {
    return tx.inventoryLevel.createMany({
      data: {
        variantId,
        locationId,
        onHand: 0,
        committed: 0,
        packed: 0,
        unavailable: 0,
        incoming: 0,
        available: 0,
        price: price ?? 0,
        cost: cost ?? 0,
      },
      skipDuplicates: true,
    });
  }

  updateLevel(
    tx: Prisma.TransactionClient,
    variantId: bigint,
    locationId: bigint,
    data: {
      onHand: number;
      committed: number;
      packed: number;
      unavailable: number;
      incoming: number;
      available: number;
      price?: Prisma.Decimal;
      cost?: Prisma.Decimal;
    },
  ) {
    return tx.inventoryLevel.update({
      where: { variantId_locationId: { variantId, locationId } },
      data: {
        onHand: data.onHand,
        committed: data.committed,
        packed: data.packed,
        unavailable: data.unavailable,
        incoming: data.incoming,
        available: data.available,
        ...(data.price !== undefined ? { price: data.price } : {}),
        ...(data.cost !== undefined ? { cost: data.cost } : {}),
      },
    });
  }

  insertMovement(tx: Prisma.TransactionClient, input: ApplyMovementInput) {
    return tx.inventoryMovement.create({
      data: {
        variantId: input.variantId,
        locationId: input.locationId,
        bucket: input.bucket,
        change: input.change,
        type: input.type,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        createdById: input.createdById,
      },
    });
  }

  sumMovements(
    tx: Prisma.TransactionClient,
    variantId: bigint,
    locationId: bigint,
    bucket: InventoryBucket,
  ) {
    return tx.inventoryMovement.aggregate({
      where: { variantId, locationId, bucket },
      _sum: { change: true },
    });
  }
}
