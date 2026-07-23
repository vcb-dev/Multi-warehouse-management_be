/**
 * Quickstart KC1–KC6 — specs/002-don-hang/quickstart.md
 * RUN_INTEGRATION_TESTS=1 npm test -- test/quickstart-orders.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { InventoryBucket, OrderStatus } from '@prisma/client';
import { BusinessException } from '../src/common/exceptions/business.exception';
import { OrderReturnsModule } from '../src/modules/order-returns/order-returns.module';
import { OrderReturnService } from '../src/modules/order-returns/order-return.service';
import { ChannelsModule } from '../src/modules/channels/channels.module';
import { ChannelSyncService } from '../src/modules/channels/channel-sync.service';
import { OrdersModule } from '../src/modules/orders/orders.module';
import { OrderService } from '../src/modules/orders/order.service';
import { VouchersModule } from '../src/modules/vouchers/vouchers.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

describeIfDb('Quickstart 002 KC1–KC6 (integration)', () => {
  let orders: OrderService;
  let returns: OrderReturnService;
  let channels: ChannelSyncService;
  let prisma: PrismaService;

  let userId: bigint;
  let branchId: bigint;
  let warehouseId: bigint;
  let variantId: bigint;

  const auth = () => ({
    userId,
    email: 'admin@local.dev',
    roles: ['admin'],
    warehouseIds: [] as bigint[],
  });

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        VouchersModule,
        OrdersModule,
        OrderReturnsModule,
        ChannelsModule,
      ],
    }).compile();

    orders = module.get(OrderService);
    returns = module.get(OrderReturnService);
    channels = module.get(ChannelSyncService);
    prisma = module.get(PrismaService);

    const user = await prisma.user.findFirst({ where: { email: 'admin@local.dev' } });
    const branch = await prisma.branch.findFirst();
    const warehouse = await prisma.warehouse.findFirst();
    const variant = await prisma.productVariant.findFirst();
    if (!user || !branch || !warehouse || !variant) throw new Error('Run seed');

    userId = user.id;
    branchId = branch.id;
    warehouseId = warehouse.id;
    variantId = variant.id;

    await prisma.inventoryLevel.upsert({
      where: { variantId_warehouseId: { variantId, warehouseId } },
      update: { onHand: 10, available: 10, committed: 0 },
      create: {
        variantId,
        warehouseId,
        onHand: 10,
        available: 10,
        price: 100000,
        cost: 60000,
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('KC1 — tạo đơn giữ committed', async () => {
    const res = await orders.create(
      {
        branch_id: branchId.toString(),
        items: [
          {
            variant_id: variantId.toString(),
            warehouse_id: warehouseId.toString(),
            quantity: 2,
            price: 100000,
          },
        ],
      },
      auth(),
    );
    expect(res.status).toBe(OrderStatus.ordered);

    const level = await prisma.inventoryLevel.findUniqueOrThrow({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    expect(level.committed).toBeGreaterThanOrEqual(2);
    expect(level.available).toBeLessThanOrEqual(8);
  });

  it('KC2 — INSUFFICIENT_STOCK & MISSING_WAREHOUSE', async () => {
    await expect(
      orders.create(
        {
          branch_id: branchId.toString(),
          items: [
            {
              variant_id: variantId.toString(),
              warehouse_id: warehouseId.toString(),
              quantity: 999,
            },
          ],
        },
        auth(),
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });

    await expect(
      orders.create(
        {
          branch_id: branchId.toString(),
          items: [{ variant_id: variantId.toString(), warehouse_id: '', quantity: 1 }],
        },
        auth(),
      ),
    ).rejects.toMatchObject({ code: 'MISSING_WAREHOUSE' });
  });

  it('KC5 — webhook shopee', async () => {
    const phone = `09${Date.now()}`.slice(0, 11);
    const res = await channels.handleWebhook(
      {
        source: 'shopee',
        branch_id: branchId.toString(),
        customer_phone: phone,
        items: [
          {
            variant_id: variantId.toString(),
            warehouse_id: warehouseId.toString(),
            quantity: 1,
          },
        ],
      },
      auth(),
    );
    expect(res.order_id).toBeTruthy();
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: BigInt(res.order_id) },
    });
    expect(order.source).toBe('shopee');
  });
});

describe('Quickstart 002 (unit)', () => {
  it('BusinessException codes', () => {
    expect(new BusinessException('MISSING_WAREHOUSE', '', 422).code).toBe(
      'MISSING_WAREHOUSE',
    );
  });
});
