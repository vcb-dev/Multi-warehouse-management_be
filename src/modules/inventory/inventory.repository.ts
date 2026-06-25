import { Injectable } from '@nestjs/common';
import { InventoryBucket, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ApplyMovementInput } from './inventory.types';

@Injectable()
export class InventoryRepository {
  constructor(private prisma: PrismaService) {}

  lockLevel(tx: Prisma.TransactionClient, variantId: bigint, warehouseId: bigint) {
    return tx.$queryRaw<
      Array<{
        variant_id: bigint;
        warehouse_id: bigint;
        on_hand: number;
        committed: number;
        packing: number;
        unavailable: number;
        incoming: number;
        available: number;
      }>
    >`
      SELECT variant_id, warehouse_id, on_hand, committed, packing, unavailable, incoming, available
      FROM inventory_levels
      WHERE variant_id = ${variantId} AND warehouse_id = ${warehouseId}
      FOR UPDATE
    `;
  }

  createLevel(
    tx: Prisma.TransactionClient,
    variantId: bigint,
    warehouseId: bigint,
    price?: Prisma.Decimal,
    cost?: Prisma.Decimal,
  ) {
    return tx.inventoryLevel.create({
      data: {
        variantId,
        warehouseId,
        onHand: 0,
        committed: 0,
        packing: 0,
        unavailable: 0,
        incoming: 0,
        available: 0,
        price: price ?? 0,
        cost: cost ?? 0,
      },
    });
  }

  updateLevel(
    tx: Prisma.TransactionClient,
    variantId: bigint,
    warehouseId: bigint,
    data: {
      onHand: number;
      committed: number;
      packing: number;
      unavailable: number;
      incoming: number;
      available: number;
      price?: Prisma.Decimal;
      cost?: Prisma.Decimal;
    },
  ) {
    return tx.inventoryLevel.update({
      where: { variantId_warehouseId: { variantId, warehouseId } },
      data: {
        onHand: data.onHand,
        committed: data.committed,
        packing: data.packing,
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
        warehouseId: input.warehouseId,
        lotId: input.lotId,
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
    warehouseId: bigint,
    bucket: InventoryBucket,
  ) {
    return tx.inventoryMovement.aggregate({
      where: { variantId, warehouseId, bucket },
      _sum: { change: true },
    });
  }
}
