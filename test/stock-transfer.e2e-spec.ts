/**
 * US3 — INV-3: tổng on_hand 2 kho không đổi sau chuyển hoàn tất.
 * Chạy: RUN_INTEGRATION_TESTS=1 npm test -- test/stock-transfer.e2e-spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  InventoryBucket,
  MovementType,
  StockTransferStatus,
} from '@prisma/client';
import { InventoryModule } from '../src/modules/inventory/inventory.module';
import { InventoryService } from '../src/modules/inventory/inventory.service';
import { TransfersModule } from '../src/modules/transfers/transfers.module';
import { StockTransferService } from '../src/modules/transfers/stock-transfer.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { adminAuth } from './helpers/auth';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

describeIfDb('US3 stock transfer (integration)', () => {
  let transferService: StockTransferService;
  let inventoryService: InventoryService;
  let prisma: PrismaService;

  let fromLocationId: bigint;
  let toLocationId: bigint;
  let variantId: bigint;
  let userId: bigint;
  let productId: bigint;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, InventoryModule, TransfersModule],
    }).compile();

    transferService = module.get(StockTransferService);
    inventoryService = module.get(InventoryService);
    prisma = module.get(PrismaService);

    const warehouses = await prisma.location.findMany({
      take: 2,
      orderBy: { id: 'asc' },
    });
    const user = await prisma.user.findFirst();
    if (warehouses.length < 2 || !user) {
      throw new Error('Run prisma db seed before integration tests');
    }
    fromLocationId = warehouses[0].id;
    toLocationId = warehouses[1].id;
    userId = user.id;

    // Variant riêng: nhiều file e2e cùng findFirst() ra variant đầu tiên nên tồn
    // kho của nhau chồng lên nhau.
    const ts = Date.now();
    const product = await prisma.product.create({
      data: {
        name: `Stock transfer E2E ${ts}`,
        alias: `stock-transfer-e2e-${ts}`,
        variants: { create: { sku: `STE-${ts}`, price: '50000' } },
      },
      include: { variants: true },
    });
    productId = product.id;
    variantId = product.variants[0].id;

    const levelBeforeSeed = await prisma.inventoryLevel.findUnique({
      where: {
        variantId_locationId: { variantId, locationId: fromLocationId },
      },
    });
    await inventoryService.applyMovement({
      variantId,
      locationId: fromLocationId,
      bucket: InventoryBucket.on_hand,
      change: 20 - (levelBeforeSeed?.onHand ?? 0),
      type: MovementType.adjust,
      referenceType: 'test',
      createdById: userId,
    });
  });

  afterAll(async () => {
    await prisma.stockTransferItem.deleteMany({ where: { variantId } });
    await prisma.inventoryMovement.deleteMany({ where: { variantId } });
    await prisma.inventoryLevel.deleteMany({ where: { variantId } });
    await prisma.productVariant.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.$disconnect();
  });

  async function sumOnHand(whIds: bigint[]) {
    const levels = await prisma.inventoryLevel.findMany({
      where: { variantId, locationId: { in: whIds } },
    });
    return levels.reduce((s, l) => s + l.onHand, 0);
  }

  it('INV-3: create → receive giữ nguyên tổng on_hand 2 kho', async () => {
    const authUser = adminAuth({
      userId,
      locationIds: [fromLocationId, toLocationId],
    });

    const totalBefore = await sumOnHand([fromLocationId, toLocationId]);
    const toBefore = await prisma.inventoryLevel.findUnique({
      where: { variantId_locationId: { variantId, locationId: toLocationId } },
    });
    const toIncomingBefore = toBefore?.incoming ?? 0;
    const toOnHandBefore = toBefore?.onHand ?? 0;

    const { data: stn } = await transferService.create(
      {
        from_location_id: fromLocationId.toString(),
        to_location_id: toLocationId.toString(),
        items: [
          {
            variant_id: variantId.toString(),
            quantity: 5,
          },
        ],
      },
      authUser,
    );

    // Luồng: nhap → submit → cho_chuyen → ship → dang_chuyen → receive.
    // Hàng chỉ rời kho đi ở bước ship.
    expect(stn.status).toBe(StockTransferStatus.nhap);
    await transferService.transition(BigInt(stn.id), 'submit', authUser);
    await transferService.transition(BigInt(stn.id), 'ship', authUser);

    const shipped = await prisma.stockTransfer.findUniqueOrThrow({
      where: { id: BigInt(stn.id) },
    });
    expect(shipped.status).toBe(StockTransferStatus.dang_chuyen);

    const fromAfterCreate = await prisma.inventoryLevel.findUnique({
      where: {
        variantId_locationId: { variantId, locationId: fromLocationId },
      },
    });
    expect(fromAfterCreate?.onHand).toBe(15);

    const totalInTransit = await sumOnHand([fromLocationId, toLocationId]);
    expect(totalInTransit).toBe(totalBefore - 5);

    // Trong lúc đang chuyển: kho nhận thấy "hàng đang về"
    const toInTransit = await prisma.inventoryLevel.findUnique({
      where: { variantId_locationId: { variantId, locationId: toLocationId } },
    });
    expect(toInTransit?.incoming).toBe(toIncomingBefore + 5);

    await transferService.receive(BigInt(stn.id), authUser);

    const totalAfter = await sumOnHand([fromLocationId, toLocationId]);
    expect(totalAfter).toBe(totalBefore);

    const toLevel = await prisma.inventoryLevel.findUnique({
      where: { variantId_locationId: { variantId, locationId: toLocationId } },
    });
    expect(toLevel?.onHand).toBe(toOnHandBefore + 5);
    expect(toLevel?.incoming).toBe(toIncomingBefore);
  });

  it('cancel hoàn on_hand kho đi và gỡ incoming kho nhận', async () => {
    const authUser = adminAuth({
      userId,
      locationIds: [fromLocationId, toLocationId],
    });

    const fromBefore = await prisma.inventoryLevel.findUnique({
      where: {
        variantId_locationId: { variantId, locationId: fromLocationId },
      },
    });
    const toBefore = await prisma.inventoryLevel.findUnique({
      where: { variantId_locationId: { variantId, locationId: toLocationId } },
    });

    const { data: stn } = await transferService.create(
      {
        from_location_id: fromLocationId.toString(),
        to_location_id: toLocationId.toString(),
        items: [
          {
            variant_id: variantId.toString(),
            quantity: 3,
          },
        ],
      },
      authUser,
    );

    // Hủy phiếu còn ở trạng thái `nhap` sẽ XOÁ hẳn phiếu và chưa từng đụng tồn;
    // muốn kiểm phần hoàn tồn thì phải đẩy qua ship trước.
    await transferService.transition(BigInt(stn.id), 'submit', authUser);
    await transferService.transition(BigInt(stn.id), 'ship', authUser);
    await transferService.cancel(BigInt(stn.id), authUser);

    const fromAfter = await prisma.inventoryLevel.findUnique({
      where: {
        variantId_locationId: { variantId, locationId: fromLocationId },
      },
    });
    const toAfter = await prisma.inventoryLevel.findUnique({
      where: { variantId_locationId: { variantId, locationId: toLocationId } },
    });

    expect(fromAfter?.onHand).toBe(fromBefore?.onHand ?? 0);
    expect(toAfter?.incoming).toBe(toBefore?.incoming ?? 0);
    expect(toAfter?.onHand).toBe(toBefore?.onHand ?? 0);
  });
});
