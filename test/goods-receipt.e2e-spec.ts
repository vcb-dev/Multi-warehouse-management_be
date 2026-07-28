/**
 * US2 — PO submit + REI confirm + incoming (integration khi có DATABASE_URL).
 * Chạy: RUN_INTEGRATION_TESTS=1 npm run test -- test/goods-receipt.e2e-spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PoStatus } from '@prisma/client';
import { InventoryModule } from '../src/modules/inventory/inventory.module';
import { PurchasingModule } from '../src/modules/purchasing/purchasing.module';
import { PurchaseOrderService } from '../src/modules/purchasing/purchase-order.service';
import { GoodsReceiptService } from '../src/modules/purchasing/goods-receipt.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

describeIfDb('US2 PO → incoming → REI confirm (integration)', () => {
  let poService: PurchaseOrderService;
  let reiService: GoodsReceiptService;
  let prisma: PrismaService;

  let supplierId: bigint;
  let locationId: bigint;
  let variantId: bigint;
  let userId: bigint;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, InventoryModule, PurchasingModule],
    }).compile();

    poService = module.get(PurchaseOrderService);
    reiService = module.get(GoodsReceiptService);
    prisma = module.get(PrismaService);

    const supplier = await prisma.supplier.findFirst({ where: { isActive: true } });
    const branch = await prisma.location.findFirst();
    const warehouse = await prisma.location.findFirst();
    const variant = await prisma.productVariant.findFirst();
    const user = await prisma.user.findFirst();
    if (!supplier || !branch || !warehouse || !variant || !user) {
      throw new Error('Run prisma db seed before integration tests');
    }
    supplierId = supplier.id;
    locationId = warehouse.id;
    variantId = variant.id;
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('submit PO tăng incoming; REI confirm tăng on_hand và giảm incoming', async () => {
    const authUser = {
      userId,
      email: 'test@local.dev',
      roles: ['admin'],
      locationIds: [locationId],
    };

    const { data: po } = await poService.create(
      {
        supplier_id: supplierId.toString(),
        location_id: locationId.toString(),
        items: [{ variant_id: variantId.toString(), quantity: 10, unit_price: 50000 }],
      },
      authUser,
    );

    await poService.transition(BigInt(po.id), 'submit', authUser);

    let level = await prisma.inventoryLevel.findUnique({
      where: { variantId_locationId: { variantId, locationId } },
    });
    expect(level?.incoming).toBe(10);
    expect(level?.onHand).toBe(0);

    const { data: rei } = await reiService.create(
      {
        supplier_id: supplierId.toString(),
        location_id: locationId.toString(),
        purchase_order_id: po.id,
        items: [
          {
            variant_id: variantId.toString(),
            quantity: 10,
            unit_price: 50000,
          },
        ],
      },
      authUser,
    );

    await reiService.confirm(BigInt(rei.id), authUser);

    level = await prisma.inventoryLevel.findUnique({
      where: { variantId_locationId: { variantId, locationId } },
    });
    expect(level?.incoming).toBe(0);
    expect(level?.onHand).toBe(10);

    const updatedPo = await prisma.purchaseOrder.findUniqueOrThrow({
      where: { id: BigInt(po.id) },
    });
    expect(updatedPo.status).toBe(PoStatus.da_nhap);
  });
});
