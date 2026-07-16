/**
 * Concurrency — chống oversell, chống deadlock, chống race tạo dòng tồn
 * (integration khi có DATABASE_URL).
 * Chạy: RUN_INTEGRATION_TESTS=1 npm run test -- test/inventory-concurrency.e2e-spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { InventoryBucket, MovementType } from '@prisma/client';
import { InventoryModule } from '../src/modules/inventory/inventory.module';
import { InventoryService } from '../src/modules/inventory/inventory.service';
import { sortForLocking } from '../src/modules/inventory/inventory.types';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { BusinessException } from '../src/common/exceptions/business.exception';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

jest.setTimeout(120_000);

describeIfDb('Inventory concurrency (integration)', () => {
  let inventory: InventoryService;
  let prisma: PrismaService;

  let warehouseId: bigint;
  let userId: bigint;
  let productId: bigint;
  // A: oversell; B, C: deadlock; D: race tạo dòng tồn lần đầu
  let variantA: bigint;
  let variantB: bigint;
  let variantC: bigint;
  let variantD: bigint;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, InventoryModule],
    }).compile();

    inventory = module.get(InventoryService);
    prisma = module.get(PrismaService);

    const warehouse = await prisma.warehouse.findFirst();
    const user = await prisma.user.findFirst();
    if (!warehouse || !user) {
      throw new Error('Run prisma db seed before integration tests');
    }
    warehouseId = warehouse.id;
    userId = user.id;

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const product = await prisma.product.create({
      data: {
        slug: `conc-test-${suffix}`,
        name: `Concurrency test ${suffix}`,
        variants: {
          create: ['A', 'B', 'C', 'D'].map((v) => ({
            sku: `CONC-${suffix}-${v}`,
          })),
        },
      },
      include: { variants: true },
    });
    productId = product.id;
    const bySku = new Map(product.variants.map((v) => [v.sku, v.id]));
    variantA = bySku.get(`CONC-${suffix}-A`)!;
    variantB = bySku.get(`CONC-${suffix}-B`)!;
    variantC = bySku.get(`CONC-${suffix}-C`)!;
    variantD = bySku.get(`CONC-${suffix}-D`)!;
  });

  afterAll(async () => {
    const variantIds = [variantA, variantB, variantC, variantD].filter(Boolean);
    if (variantIds.length) {
      await prisma.inventoryMovement.deleteMany({
        where: { variantId: { in: variantIds } },
      });
      await prisma.inventoryLevel.deleteMany({
        where: { variantId: { in: variantIds } },
      });
    }
    if (productId) {
      await prisma.product.delete({ where: { id: productId } });
    }
    await prisma.$disconnect();
  });

  const reserveOne = (variantId: bigint) =>
    inventory.applyMovement({
      variantId,
      warehouseId,
      bucket: InventoryBucket.committed,
      change: 1,
      type: MovementType.order_reserve,
      referenceType: 'concurrency_test',
      createdById: userId,
    });

  it('10 request tranh 4 tồn: đúng 4 thắng, 6 bị INSUFFICIENT_STOCK, không oversell', async () => {
    await inventory.applyMovement({
      variantId: variantA,
      warehouseId,
      bucket: InventoryBucket.on_hand,
      change: 4,
      type: MovementType.receipt,
      referenceType: 'concurrency_test',
      createdById: userId,
    });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => reserveOne(variantA)),
    );

    const wins = results.filter((r) => r.status === 'fulfilled');
    const losses = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    expect(wins).toHaveLength(4);
    expect(losses).toHaveLength(6);
    for (const loss of losses) {
      expect(loss.reason).toBeInstanceOf(BusinessException);
      expect((loss.reason as BusinessException).code).toBe(
        'INSUFFICIENT_STOCK',
      );
    }

    const level = await prisma.inventoryLevel.findUniqueOrThrow({
      where: {
        variantId_warehouseId: { variantId: variantA, warehouseId },
      },
    });
    expect(level.onHand).toBe(4);
    expect(level.committed).toBe(4);
    expect(level.available).toBe(0);

    // Sổ cái khớp số dư sau bão request
    const check = await inventory.reconcile(variantA, warehouseId);
    expect(check.ok).toBe(true);
  });

  it('2 chứng từ khóa cùng cặp biến thể theo thứ tự ngược nhau: không deadlock', async () => {
    for (const variantId of [variantB, variantC]) {
      await inventory.applyMovement({
        variantId,
        warehouseId,
        bucket: InventoryBucket.on_hand,
        change: 100,
        type: MovementType.receipt,
        referenceType: 'concurrency_test',
        createdById: userId,
      });
    }

    // Mô phỏng đúng pattern của các service chứng từ: một transaction,
    // items được sortForLocking trước khi applyMovement từng dòng.
    const reserveBatch = (items: { variantId: bigint }[]) =>
      prisma.$transaction(
        async (tx) => {
          for (const item of sortForLocking(items)) {
            await inventory.applyMovement(
              {
                variantId: item.variantId,
                warehouseId,
                bucket: InventoryBucket.committed,
                change: 1,
                type: MovementType.order_reserve,
                referenceType: 'concurrency_test',
                createdById: userId,
              },
              tx,
            );
          }
        },
        { maxWait: 10_000, timeout: 20_000 },
      );

    const rounds = 3;
    for (let i = 0; i < rounds; i++) {
      const results = await Promise.allSettled([
        reserveBatch([{ variantId: variantB }, { variantId: variantC }]),
        reserveBatch([{ variantId: variantC }, { variantId: variantB }]),
      ]);
      for (const r of results) {
        expect(r.status).toBe('fulfilled');
      }
    }

    for (const variantId of [variantB, variantC]) {
      const level = await prisma.inventoryLevel.findUniqueOrThrow({
        where: { variantId_warehouseId: { variantId, warehouseId } },
      });
      expect(level.committed).toBe(rounds * 2);
    }
  });

  it('8 request đầu tiên cùng tạo dòng tồn mới: không đụng trùng khóa chính', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        inventory.applyMovement({
          variantId: variantD,
          warehouseId,
          bucket: InventoryBucket.on_hand,
          change: 1,
          type: MovementType.receipt,
          referenceType: 'concurrency_test',
          createdById: userId,
        }),
      ),
    );

    for (const r of results) {
      expect(r.status).toBe('fulfilled');
    }

    const level = await prisma.inventoryLevel.findUniqueOrThrow({
      where: { variantId_warehouseId: { variantId: variantD, warehouseId } },
    });
    expect(level.onHand).toBe(8);

    const check = await inventory.reconcile(variantD, warehouseId);
    expect(check.ok).toBe(true);
  });
});
