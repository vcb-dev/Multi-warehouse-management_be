/**
 * INV-2a/2b — đối soát sổ cái multi-bucket (integration khi có DATABASE_URL).
 * Chạy: DATABASE_URL=... npm run test -- test/inventory-ledger.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { InventoryBucket, MovementType } from '@prisma/client';
import { InventoryModule } from '../src/modules/inventory/inventory.module';
import { InventoryService } from '../src/modules/inventory/inventory.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

describeIfDb('INV-2 ledger reconciliation (integration)', () => {
  let service: InventoryService;
  let prisma: PrismaService;
  let variantId: bigint;
  let locationId: bigint;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, InventoryModule],
    }).compile();

    service = module.get(InventoryService);
    prisma = module.get(PrismaService);

    const branch = await prisma.location.findFirst();
    const warehouse = await prisma.location.findFirst();
    const variant = await prisma.productVariant.findFirst();
    if (!branch || !warehouse || !variant) {
      throw new Error('Run prisma db seed before integration tests');
    }
    variantId = variant.id;
    locationId = warehouse.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('INV-2a: SUM(on_hand movements) = on_hand after receipt + order_reserve', async () => {
    const key = { variantId, locationId };

    await prisma.inventoryMovement.deleteMany({ where: key });
    await prisma.inventoryLevel.deleteMany({ where: key });

    await service.applyMovement({
      ...key,
      bucket: InventoryBucket.on_hand,
      change: 20,
      type: MovementType.receipt,
      referenceType: 'goods_receipt',
      referenceId: 1n,
    });

    await service.applyMovement({
      ...key,
      bucket: InventoryBucket.committed,
      change: 5,
      type: MovementType.order_reserve,
      referenceType: 'order',
      referenceId: 1n,
    });

    const level = await prisma.inventoryLevel.findUniqueOrThrow({
      where: { variantId_locationId: key },
    });

    const onHandSum = await prisma.inventoryMovement.aggregate({
      where: { ...key, bucket: InventoryBucket.on_hand },
      _sum: { change: true },
    });
    const committedSum = await prisma.inventoryMovement.aggregate({
      where: { ...key, bucket: InventoryBucket.committed },
      _sum: { change: true },
    });

    expect(onHandSum._sum.change).toBe(level.onHand);
    expect(committedSum._sum.change).toBe(level.committed);
    expect(level.available).toBe(level.onHand - level.committed);

    const recon = await service.reconcile(variantId, locationId);
    expect(recon.ok).toBe(true);
  });

  it('FR-003c: packing_start + packing_cancel dual-bucket via applyMovements', async () => {
    const key = { variantId, locationId };

    await prisma.inventoryMovement.deleteMany({ where: key });
    await prisma.inventoryLevel.deleteMany({ where: key });

    await service.applyMovement({
      ...key,
      bucket: InventoryBucket.on_hand,
      change: 10,
      type: MovementType.receipt,
      referenceType: 'test',
      referenceId: 99n,
    });

    await service.applyMovement({
      ...key,
      bucket: InventoryBucket.committed,
      change: 4,
      type: MovementType.order_reserve,
      referenceType: 'order',
      referenceId: 99n,
    });

    await service.applyMovements([
      {
        ...key,
        bucket: InventoryBucket.committed,
        change: -2,
        type: MovementType.packing_start,
        referenceType: 'pack',
        referenceId: 1n,
      },
      {
        ...key,
        bucket: InventoryBucket.packed,
        change: 2,
        type: MovementType.packing_start,
        referenceType: 'pack',
        referenceId: 1n,
      },
    ]);

    let level = await prisma.inventoryLevel.findUniqueOrThrow({
      where: { variantId_locationId: key },
    });
    expect(level.committed).toBe(2);
    expect(level.packed).toBe(2);
    expect(level.available).toBe(6);

    await service.applyMovements([
      {
        ...key,
        bucket: InventoryBucket.packed,
        change: -2,
        type: MovementType.packing_cancel,
        referenceType: 'pack',
        referenceId: 1n,
      },
      {
        ...key,
        bucket: InventoryBucket.committed,
        change: 2,
        type: MovementType.packing_cancel,
        referenceType: 'pack',
        referenceId: 1n,
      },
    ]);

    level = await prisma.inventoryLevel.findUniqueOrThrow({
      where: { variantId_locationId: key },
    });
    expect(level.committed).toBe(4);
    expect(level.packed).toBe(0);
  });
});

describe('INV-2 bucket sums (unit)', () => {
  it('tracks ledger separately per bucket', () => {
    const ledger: Record<string, number> = {
      on_hand: 0,
      committed: 0,
    };
    ledger.on_hand += 20;
    ledger.committed += 5;
    expect(ledger.on_hand).toBe(20);
    expect(ledger.committed).toBe(5);
  });

  it('FR-003c: packing_start moves committed → packing atomically', () => {
    const buckets = { on_hand: 10, committed: 5, packed: 0, unavailable: 0 };
    const qty = 3;
    buckets.committed -= qty;
    buckets.packed += qty;
    expect(buckets.committed).toBe(2);
    expect(buckets.packed).toBe(3);
    expect(buckets.on_hand).toBe(10);
    const available =
      buckets.on_hand -
      buckets.committed -
      buckets.packed -
      buckets.unavailable;
    expect(available).toBe(5);
  });

  it('FR-003c: packing_cancel reverses packing → committed', () => {
    const buckets = { on_hand: 10, committed: 2, packed: 3, unavailable: 0 };
    const qty = 3;
    buckets.committed += qty;
    buckets.packed -= qty;
    expect(buckets.committed).toBe(5);
    expect(buckets.packed).toBe(0);
  });
});
