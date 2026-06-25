/**
 * US1 guards — INSUFFICIENT_STOCK, MISSING_WAREHOUSE
 */
import { Test, TestingModule } from '@nestjs/testing';
import { OrdersModule } from '../src/modules/orders/orders.module';
import { OrderService } from '../src/modules/orders/order.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

describeIfDb('order guards', () => {
  let orders: OrderService;
  let prisma: PrismaService;
  let branchId: bigint;
  let warehouseId: bigint;
  let variantId: bigint;
  let userId: bigint;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, OrdersModule],
    }).compile();
    orders = module.get(OrderService);
    prisma = module.get(PrismaService);
    branchId = (await prisma.branch.findFirstOrThrow()).id;
    warehouseId = (await prisma.warehouse.findFirstOrThrow()).id;
    variantId = (await prisma.productVariant.findFirstOrThrow()).id;
    userId = (await prisma.user.findFirstOrThrow()).id;
  });

  afterAll(() => prisma.$disconnect());

  it('MISSING_WAREHOUSE', async () => {
    await expect(
      orders.create(
        { branch_id: branchId.toString(), items: [{ variant_id: variantId.toString(), warehouse_id: '', quantity: 1 }] },
        { userId, email: 't', roles: ['admin'], warehouseIds: [] },
      ),
    ).rejects.toMatchObject({ code: 'MISSING_WAREHOUSE' });
  });
});
