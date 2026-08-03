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

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

jest.setTimeout(120_000);

describeIfDb('Inventory concurrency (integration)', () => {
  let inventory: InventoryService;
  let prisma: PrismaService;

  let locationId: bigint;
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

    const warehouse = await prisma.location.findFirst();
    const user = await prisma.user.findFirst();
    if (!warehouse || !user) {
      throw new Error('Run prisma db seed before integration tests');
    }
    locationId = warehouse.id;
    userId = user.id;

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const product = await prisma.product.create({
      data: {
        alias: `conc-test-${suffix}`,
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
      locationId,
      bucket: InventoryBucket.committed,
      change: 1,
      type: MovementType.order_reserve,
      referenceType: 'concurrency_test',
      createdById: userId,
    });

  it('10 request tranh 4 tồn: không mất cập nhật, available âm đúng bằng phần vượt', async () => {
    await inventory.applyMovement({
      variantId: variantA,
      locationId,
      bucket: InventoryBucket.on_hand,
      change: 4,
      type: MovementType.receipt,
      referenceType: 'concurrency_test',
      createdById: userId,
    });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => reserveOne(variantA)),
    );

    // Giữ chỗ vượt tồn KHÔNG còn bị chặn ở tầng này: bán âm là hành vi thiết kế
    // (giống Sapo), chốt chặn đã dời sang bước đóng gói/đẩy vận chuyển —
    // INSUFFICIENT_STOCK giờ chỉ còn ở FulfillmentService.
    const losses = results.filter((r) => r.status === 'rejected');
    expect(losses).toHaveLength(0);

    // Thứ THẬT SỰ cần bảo vệ ở đây là khoá hàng: 10 request đồng thời phải cộng
    // đủ 10, không được mất cập nhật nào (lost update).
    const level = await prisma.inventoryLevel.findUniqueOrThrow({
      where: {
        variantId_locationId: { variantId: variantA, locationId },
      },
    });
    expect(level.onHand).toBe(4);
    expect(level.committed).toBe(10);
    expect(level.available).toBe(-6);

    // Sổ cái khớp số dư sau bão request
    const check = await inventory.reconcile(variantA, locationId);
    expect(check.ok).toBe(true);
  });

  it('2 chứng từ khóa cùng cặp biến thể theo thứ tự ngược nhau: không deadlock', async () => {
    for (const variantId of [variantB, variantC]) {
      await inventory.applyMovement({
        variantId,
        locationId,
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
                locationId,
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
        where: { variantId_locationId: { variantId, locationId } },
      });
      expect(level.committed).toBe(rounds * 2);
    }
  });

  it('8 request đầu tiên cùng tạo dòng tồn mới: không đụng trùng khóa chính', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        inventory.applyMovement({
          variantId: variantD,
          locationId,
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
      where: { variantId_locationId: { variantId: variantD, locationId } },
    });
    expect(level.onHand).toBe(8);

    const check = await inventory.reconcile(variantD, locationId);
    expect(check.ok).toBe(true);
  });
});
