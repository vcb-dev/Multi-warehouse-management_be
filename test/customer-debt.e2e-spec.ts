/**
 * Công nợ KH: bán hàng ghi nợ, thanh toán giảm nợ, hủy đơn đảo nợ.
 * Chạy: RUN_INTEGRATION_TESTS=1 npm test -- --config ./test/jest-e2e.json customer-debt
 */
import { Test, TestingModule } from '@nestjs/testing';
import { InventoryBucket, MovementType, PaymentStatus } from '@prisma/client';
import { InventoryModule } from '../src/modules/inventory/inventory.module';
import { InventoryService } from '../src/modules/inventory/inventory.service';
import { OrdersModule } from '../src/modules/orders/orders.module';
import { OrderService } from '../src/modules/orders/order.service';
import { VouchersModule } from '../src/modules/vouchers/vouchers.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

describeIfDb('Customer debt (integration)', () => {
  let orderService: OrderService;
  let inventoryService: InventoryService;
  let prisma: PrismaService;

  let branchId: bigint;
  let warehouseId: bigint;
  let variantId: bigint;
  let customerId: bigint;
  let userId: bigint;
  let authUser: {
    userId: bigint;
    email: string;
    roles: string[];
    warehouseIds: bigint[];
  };

  async function debtBalance() {
    const agg = await prisma.customerLedgerEntry.aggregate({
      where: { customerId },
      _sum: { amount: true },
    });
    return Number(agg._sum.amount ?? 0);
  }

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, InventoryModule, VouchersModule, OrdersModule],
    }).compile();

    orderService = module.get(OrderService);
    inventoryService = module.get(InventoryService);
    prisma = module.get(PrismaService);

    const warehouse = await prisma.warehouse.findFirst({
      orderBy: { id: 'asc' },
    });
    const variant = await prisma.productVariant.findFirst();
    const user = await prisma.user.findFirst();
    const customer = await prisma.customer.findFirst();
    if (!warehouse || !variant || !user || !customer) {
      throw new Error('Run prisma db seed before integration tests');
    }
    branchId = warehouse.branchId;
    warehouseId = warehouse.id;
    variantId = variant.id;
    customerId = customer.id;
    userId = user.id;
    authUser = {
      userId,
      email: 'test@local.dev',
      roles: ['admin'],
      warehouseIds: [warehouseId],
    };

    const level = await prisma.inventoryLevel.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId } },
    });
    await inventoryService.applyMovement({
      variantId,
      warehouseId,
      bucket: InventoryBucket.on_hand,
      change: 50 - (level?.onHand ?? 0),
      type: MovementType.adjust,
      referenceType: 'test',
      createdById: userId,
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('bán hàng ghi nợ, thanh toán một phần rồi tất toán', async () => {
    const balanceBefore = await debtBalance();

    const created = await orderService.create(
      {
        branch_id: branchId.toString(),
        customer_id: customerId.toString(),
        items: [
          {
            variant_id: variantId.toString(),
            warehouse_id: warehouseId.toString(),
            quantity: 2,
            price: 100_000,
          },
        ],
        paid_amount: 50_000,
      },
      authUser,
    );

    // Nợ = tổng đơn 200k − đã trả 50k
    expect(await debtBalance()).toBe(balanceBefore + 150_000);

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: BigInt(created.id) },
    });
    expect(order.paymentStatus).toBe(PaymentStatus.mot_phan);
    expect(Number(order.paidAmount)).toBe(50_000);

    // Phiếu thu thanh toán ban đầu
    const receipts = await prisma.voucher.findMany({
      where: { referenceType: 'order', referenceId: BigInt(created.id) },
    });
    expect(receipts).toHaveLength(1);
    expect(Number(receipts[0].amountIn)).toBe(50_000);

    // Tất toán phần còn lại
    const paid = await orderService.pay(BigInt(created.id), {}, authUser);
    expect(paid.payment_status).toBe(PaymentStatus.da_thanh_toan);
    expect(await debtBalance()).toBe(balanceBefore);
  });

  it('hủy đơn chưa thanh toán đảo hết nợ', async () => {
    const balanceBefore = await debtBalance();

    const created = await orderService.create(
      {
        branch_id: branchId.toString(),
        customer_id: customerId.toString(),
        items: [
          {
            variant_id: variantId.toString(),
            warehouse_id: warehouseId.toString(),
            quantity: 1,
            price: 80_000,
          },
        ],
      },
      authUser,
    );

    expect(await debtBalance()).toBe(balanceBefore + 80_000);

    await orderService.transition(
      BigInt(created.id),
      { action: 'cancel' },
      authUser,
    );

    expect(await debtBalance()).toBe(balanceBefore);
  });
});
