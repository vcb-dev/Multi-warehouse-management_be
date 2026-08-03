/**
 * US1 guards — INSUFFICIENT_STOCK, MISSING_WAREHOUSE
 */
import { Test, TestingModule } from '@nestjs/testing';
import { OrdersModule } from '../src/modules/orders/orders.module';
import { VouchersModule } from '../src/modules/vouchers/vouchers.module';
import { OrderService } from '../src/modules/orders/order.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { adminAuth } from './helpers/auth';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

describeIfDb('order guards', () => {
  let orders: OrderService;
  let prisma: PrismaService;
  let locationId: bigint;
  let variantId: bigint;
  let userId: bigint;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, VouchersModule, OrdersModule],
    }).compile();
    orders = module.get(OrderService);
    prisma = module.get(PrismaService);
    locationId = (await prisma.location.findFirstOrThrow()).id;
    variantId = (await prisma.productVariant.findFirstOrThrow()).id;
    userId = (await prisma.user.findFirstOrThrow()).id;
  });

  afterAll(() => prisma.$disconnect());

  it('MISSING_WAREHOUSE', async () => {
    await expect(
      orders.create(
        { location_id: locationId.toString(), items: [{ variant_id: variantId.toString(), location_id: '', quantity: 1 }] },
        adminAuth({ userId }),
      ),
    ).rejects.toMatchObject({ code: 'MISSING_WAREHOUSE' });
  });
});
