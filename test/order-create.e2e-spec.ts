/**
 * US1 — create giữ tồn. Chạy: RUN_INTEGRATION_TESTS=1 npm test -- test/order-create.e2e-spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { OrdersModule } from '../src/modules/orders/orders.module';
import { VouchersModule } from '../src/modules/vouchers/vouchers.module';
import { OrderService } from '../src/modules/orders/order.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

describeIfDb('order create reserves stock', () => {
  let orders: OrderService;
  let prisma: PrismaService;
  let branchId: bigint;
  let warehouseId: bigint;
  let variantId: bigint;
  let userId: bigint;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, VouchersModule, OrdersModule],
    }).compile();
    orders = module.get(OrderService);
    prisma = module.get(PrismaService);
    const branch = await prisma.branch.findFirstOrThrow();
    const warehouse = await prisma.warehouse.findFirstOrThrow();
    const variant = await prisma.productVariant.findFirstOrThrow();
    const user = await prisma.user.findFirstOrThrow();
    branchId = branch.id;
    warehouseId = warehouse.id;
    variantId = variant.id;
    userId = user.id;
    await prisma.inventoryLevel.upsert({
      where: { variantId_warehouseId: { variantId, warehouseId } },
      update: { onHand: 10, available: 10, committed: 0 },
      create: { variantId, warehouseId, onHand: 10, available: 10, price: 0, cost: 0 },
    });
  });

  afterAll(() => prisma.$disconnect());

  it('committed tăng khi tạo đơn', async () => {
    await orders.create(
      {
        branch_id: branchId.toString(),
        items: [{ variant_id: variantId.toString(), warehouse_id: warehouseId.toString(), quantity: 1, price: 1 }],
      },
      { userId, email: 't', roles: ['admin'], warehouseIds: [warehouseId] },
    );
    const level = await prisma.inventoryLevel.findUniqueOrThrow({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(level.committed).toBeGreaterThanOrEqual(1);
  });
});
