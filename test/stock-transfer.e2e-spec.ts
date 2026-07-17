/**
 * US3 — INV-3: tổng on_hand 2 kho không đổi sau chuyển hoàn tất.
 * Chạy: RUN_INTEGRATION_TESTS=1 npm test -- test/stock-transfer.e2e-spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { InventoryBucket, MovementType, StockTransferStatus } from '@prisma/client';
import { InventoryModule } from '../src/modules/inventory/inventory.module';
import { InventoryService } from '../src/modules/inventory/inventory.service';
import { TransfersModule } from '../src/modules/transfers/transfers.module';
import { StockTransferService } from '../src/modules/transfers/stock-transfer.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

describeIfDb('US3 stock transfer (integration)', () => {
  let transferService: StockTransferService;
  let inventoryService: InventoryService;
  let prisma: PrismaService;

  let fromWarehouseId: bigint;
  let toWarehouseId: bigint;
  let variantId: bigint;
  let userId: bigint;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, InventoryModule, TransfersModule],
    }).compile();

    transferService = module.get(StockTransferService);
    inventoryService = module.get(InventoryService);
    prisma = module.get(PrismaService);

    const warehouses = await prisma.warehouse.findMany({ take: 2, orderBy: { id: 'asc' } });
    const variant = await prisma.productVariant.findFirst();
    const user = await prisma.user.findFirst();
    if (warehouses.length < 2 || !variant || !user) {
      throw new Error('Run prisma db seed before integration tests');
    }
    fromWarehouseId = warehouses[0].id;
    toWarehouseId = warehouses[1].id;
    variantId = variant.id;
    userId = user.id;

    const levelBeforeSeed = await prisma.inventoryLevel.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId: fromWarehouseId } },
    });
    await inventoryService.applyMovement({
      variantId,
      warehouseId: fromWarehouseId,
      bucket: InventoryBucket.on_hand,
      change: 20 - (levelBeforeSeed?.onHand ?? 0),
      type: MovementType.adjust,
      referenceType: 'test',
      createdById: userId,
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function sumOnHand(whIds: bigint[]) {
    const levels = await prisma.inventoryLevel.findMany({
      where: { variantId, warehouseId: { in: whIds } },
    });
    return levels.reduce((s, l) => s + l.onHand, 0);
  }

  it('INV-3: create → receive giữ nguyên tổng on_hand 2 kho', async () => {
    const authUser = {
      userId,
      email: 'test@local.dev',
      roles: ['admin'],
      warehouseIds: [fromWarehouseId, toWarehouseId],
    };

    const totalBefore = await sumOnHand([fromWarehouseId, toWarehouseId]);
    const toBefore = await prisma.inventoryLevel.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId: toWarehouseId } },
    });
    const toIncomingBefore = toBefore?.incoming ?? 0;
    const toOnHandBefore = toBefore?.onHand ?? 0;

    const { data: stn } = await transferService.create(
      {
        from_warehouse_id: fromWarehouseId.toString(),
        to_warehouse_id: toWarehouseId.toString(),
        items: [
          {
            variant_id: variantId.toString(),
            quantity: 5,
          },
        ],
      },
      authUser,
    );

    expect(stn.status).toBe(StockTransferStatus.dang_chuyen);

    const fromAfterCreate = await prisma.inventoryLevel.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId: fromWarehouseId } },
    });
    expect(fromAfterCreate?.onHand).toBe(15);

    const totalInTransit = await sumOnHand([fromWarehouseId, toWarehouseId]);
    expect(totalInTransit).toBe(totalBefore - 5);

    // Trong lúc đang chuyển: kho nhận thấy "hàng đang về"
    const toInTransit = await prisma.inventoryLevel.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId: toWarehouseId } },
    });
    expect(toInTransit?.incoming).toBe(toIncomingBefore + 5);

    await transferService.receive(BigInt(stn.id), authUser);

    const totalAfter = await sumOnHand([fromWarehouseId, toWarehouseId]);
    expect(totalAfter).toBe(totalBefore);

    const toLevel = await prisma.inventoryLevel.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId: toWarehouseId } },
    });
    expect(toLevel?.onHand).toBe(toOnHandBefore + 5);
    expect(toLevel?.incoming).toBe(toIncomingBefore);
  });

  it('cancel hoàn on_hand kho đi và gỡ incoming kho nhận', async () => {
    const authUser = {
      userId,
      email: 'test@local.dev',
      roles: ['admin'],
      warehouseIds: [fromWarehouseId, toWarehouseId],
    };

    const fromBefore = await prisma.inventoryLevel.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId: fromWarehouseId } },
    });
    const toBefore = await prisma.inventoryLevel.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId: toWarehouseId } },
    });

    const { data: stn } = await transferService.create(
      {
        from_warehouse_id: fromWarehouseId.toString(),
        to_warehouse_id: toWarehouseId.toString(),
        items: [
          {
            variant_id: variantId.toString(),
            quantity: 3,
          },
        ],
      },
      authUser,
    );

    await transferService.cancel(BigInt(stn.id), authUser);

    const fromAfter = await prisma.inventoryLevel.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId: fromWarehouseId } },
    });
    const toAfter = await prisma.inventoryLevel.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId: toWarehouseId } },
    });

    expect(fromAfter?.onHand).toBe(fromBefore?.onHand ?? 0);
    expect(toAfter?.incoming).toBe(toBefore?.incoming ?? 0);
    expect(toAfter?.onHand).toBe(toBefore?.onHand ?? 0);
  });
});
