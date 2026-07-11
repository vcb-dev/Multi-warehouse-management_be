/**
 * Quickstart KC1–KC6 — specs/006-quan-ly-kho/quickstart.md
 * Chạy: RUN_INTEGRATION_TESTS=1 npm run test:quickstart
 */
import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  InventoryBucket,
  MovementType,
  PoStatus,
  StockTransferStatus,
} from '@prisma/client';
import { InventoryModule } from '../src/modules/inventory/inventory.module';
import { InventoryService } from '../src/modules/inventory/inventory.service';
import { ReconcileService } from '../src/modules/inventory/reconcile.service';
import { PurchasingModule } from '../src/modules/purchasing/purchasing.module';
import { GoodsReceiptService } from '../src/modules/purchasing/goods-receipt.service';
import { PurchaseOrderService } from '../src/modules/purchasing/purchase-order.service';
import { PurchaseReturnService } from '../src/modules/purchasing/purchase-return.service';
import { TransfersModule } from '../src/modules/transfers/transfers.module';
import { StockTransferService } from '../src/modules/transfers/stock-transfer.service';
import { VouchersModule } from '../src/modules/vouchers/vouchers.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { computeAvailable } from '../src/modules/inventory/inventory.types';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

describeIfDb('Quickstart KC1–KC6 (integration)', () => {
  let inventory: InventoryService;
  let reconcile: ReconcileService;
  let poService: PurchaseOrderService;
  let reiService: GoodsReceiptService;
  let pvnService: PurchaseReturnService;
  let transferService: StockTransferService;
  let prisma: PrismaService;

  let supplierId: bigint;
  let branchId: bigint;
  let warehouseK1: bigint;
  let warehouseK2: bigint;
  let variantId: bigint;
  let userId: bigint;
  let lotCode: string;
  let lotId: bigint;

  const adminUser = () => ({
    userId,
    email: 'admin@local.dev',
    roles: ['admin'],
    warehouseIds: [warehouseK1, warehouseK2],
  });

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        InventoryModule,
        PurchasingModule,
        TransfersModule,
        VouchersModule,
      ],
    }).compile();

    inventory = module.get(InventoryService);
    reconcile = module.get(ReconcileService);
    poService = module.get(PurchaseOrderService);
    reiService = module.get(GoodsReceiptService);
    pvnService = module.get(PurchaseReturnService);
    transferService = module.get(StockTransferService);
    prisma = module.get(PrismaService);

    const supplier = await prisma.supplier.findFirst({ where: { isActive: true } });
    const branch = await prisma.branch.findFirst();
    const warehouses = await prisma.warehouse.findMany({ take: 2, orderBy: { id: 'asc' } });
    const variant = await prisma.productVariant.findFirst();
    const user = await prisma.user.findFirst({ where: { email: 'admin@local.dev' } });
    if (!supplier || !branch || warehouses.length < 2 || !variant || !user) {
      throw new Error('Run prisma db seed before integration tests');
    }
    supplierId = supplier.id;
    branchId = branch.id;
    warehouseK1 = warehouses[0].id;
    warehouseK2 = warehouses[1].id;
    variantId = variant.id;
    userId = user.id;
    lotCode = `KC-LOT-${Date.now()}`;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('KC1 — available = on_hand - committed - packing - unavailable', async () => {
    const key = { variantId, warehouseId: warehouseK1 };
    await prisma.inventoryMovement.deleteMany({ where: key });
    await prisma.inventoryLevel.deleteMany({ where: key });

    await inventory.applyMovement({
      ...key,
      bucket: InventoryBucket.on_hand,
      change: 10,
      type: MovementType.receipt,
      referenceType: 'test',
      referenceId: 1n,
      createdById: userId,
    });

    await inventory.applyMovement({
      ...key,
      bucket: InventoryBucket.committed,
      change: 3,
      type: MovementType.order_reserve,
      referenceType: 'order',
      referenceId: 2n,
      createdById: userId,
    });

    const level = await prisma.inventoryLevel.findUniqueOrThrow({
      where: { variantId_warehouseId: key },
    });

    expect(level.onHand).toBe(10);
    expect(level.committed).toBe(3);
    expect(level.available).toBe(7);
    expect(level.available).toBe(
      computeAvailable({
        onHand: level.onHand,
        committed: level.committed,
        packing: level.packing,
        unavailable: level.unavailable,
      }),
    );
  });

  it('KC2 — PO submit → REI confirm (incoming → on_hand)', async () => {
    const auth = adminUser();

    const { data: po } = await poService.create(
      {
        supplier_id: supplierId.toString(),
        branch_id: branchId.toString(),
        warehouse_id: warehouseK1.toString(),
        items: [{ variant_id: variantId.toString(), quantity: 20, unit_price: 50000 }],
      },
      auth,
    );
    expect(po.status).toBe(PoStatus.don_nhap);

    await poService.transition(BigInt(po.id), 'submit', auth);

    let level = await prisma.inventoryLevel.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId: warehouseK1 } },
    });
    expect(level?.incoming).toBe(20);

    const { data: rei } = await reiService.create(
      {
        supplier_id: supplierId.toString(),
        warehouse_id: warehouseK1.toString(),
        purchase_order_id: po.id,
        items: [
          {
            variant_id: variantId.toString(),
            quantity: 20,
            unit_price: 50000,
            lot: { code: lotCode, manufactured_at: '2025-01-01' },
          },
        ],
      },
      auth,
    );

    await reiService.confirm(BigInt(rei.id), auth);

    level = await prisma.inventoryLevel.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId: warehouseK1 } },
    });
    expect(level?.incoming).toBe(0);
    expect(level?.onHand).toBeGreaterThanOrEqual(20);

    const lot = await prisma.lot.findFirstOrThrow({
      where: { variantId, code: lotCode },
    });
    lotId = lot.id;

    const movements = await prisma.inventoryMovement.findMany({
      where: {
        variantId,
        warehouseId: warehouseK1,
        type: { in: [MovementType.incoming_receipt, MovementType.receipt] },
      },
    });
    expect(movements.length).toBeGreaterThanOrEqual(2);
  });

  it('KC3 — chuyển kho K1→K2 giữ tổng on_hand', async () => {
    const auth = adminUser();

    async function sumOnHand() {
      const levels = await prisma.inventoryLevel.findMany({
        where: { variantId, warehouseId: { in: [warehouseK1, warehouseK2] } },
      });
      return levels.reduce((s, l) => s + l.onHand, 0);
    }

    const totalBefore = await sumOnHand();

    const { data: stn } = await transferService.create(
      {
        from_warehouse_id: warehouseK1.toString(),
        to_warehouse_id: warehouseK2.toString(),
        items: [
          {
            variant_id: variantId.toString(),
            lot_id: lotId.toString(),
            quantity: 5,
          },
        ],
      },
      auth,
    );
    expect(stn.status).toBe(StockTransferStatus.dang_chuyen);

    await transferService.receive(BigInt(stn.id), auth);

    expect(await sumOnHand()).toBe(totalBefore);

    const outIn = await prisma.inventoryMovement.findMany({
      where: {
        variantId,
        referenceType: 'stock_transfer',
        referenceId: BigInt(stn.id),
        type: { in: [MovementType.transfer_out, MovementType.transfer_in] },
      },
    });
    expect(outIn).toHaveLength(2);
  });

  it('KC4 — đối soát sổ cái đa bucket', async () => {
    const report = await reconcile.runFullReconcile();
    expect(report.ok).toBe(true);
    expect(report.mismatches).toHaveLength(0);

    const recon = await inventory.reconcile(variantId, warehouseK1);
    expect(recon.ok).toBe(true);
    expect(recon.available_formula_ok).toBe(true);
  });

  it('KC5 — trả hàng nhập; chặn trả vượt', async () => {
    const auth = adminUser();

    await pvnService.create(
      {
        supplier_id: supplierId.toString(),
        warehouse_id: warehouseK1.toString(),
        items: [
          {
            variant_id: variantId.toString(),
            lot_id: lotId.toString(),
            quantity: 3,
            unit_price: 50000,
          },
        ],
      },
      auth,
    );

    const afterReturn = await prisma.inventoryLevel.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId: warehouseK1 } },
    });
    const onHandBeforeExceed = afterReturn?.onHand ?? 0;

    const returnOut = await prisma.inventoryMovement.findFirst({
      where: {
        variantId,
        warehouseId: warehouseK1,
        type: MovementType.return_out,
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(returnOut?.change).toBe(-3);

    await expect(
      pvnService.create(
        {
          supplier_id: supplierId.toString(),
          warehouse_id: warehouseK1.toString(),
          items: [
            {
              variant_id: variantId.toString(),
              lot_id: lotId.toString(),
              quantity: 18,
              unit_price: 50000,
            },
          ],
        },
        auth,
      ),
    ).rejects.toMatchObject({ code: 'RETURN_EXCEEDS_RECEIPT' });

    const unchanged = await prisma.inventoryLevel.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId: warehouseK1 } },
    });
    expect(unchanged?.onHand).toBe(onHandBeforeExceed);
  });

  it('KC6 — SAME_WAREHOUSE, FORBIDDEN_SCOPE, hủy STN', async () => {
    const auth = adminUser();
    const lot = await prisma.lot.upsert({
      where: { variantId_code: { variantId, code: `${lotCode}-STN-CANCEL` } },
      create: { variantId, code: `${lotCode}-STN-CANCEL` },
      update: {},
    });

    const levelBeforeSetup = await prisma.inventoryLevel.findUnique({
      where: { variantId_warehouseId: { variantId, warehouseId: warehouseK1 } },
    });
    await inventory.applyMovement({
      variantId,
      warehouseId: warehouseK1,
      bucket: InventoryBucket.on_hand,
      change: 10 - (levelBeforeSetup?.onHand ?? 0),
      type: MovementType.adjust,
      referenceType: 'test',
      createdById: userId,
    });

    await expect(
      transferService.create(
        {
          from_warehouse_id: warehouseK1.toString(),
          to_warehouse_id: warehouseK1.toString(),
          items: [
            {
              variant_id: variantId.toString(),
              lot_id: lot.id.toString(),
              quantity: 1,
            },
          ],
        },
        auth,
      ),
    ).rejects.toMatchObject({ code: 'SAME_WAREHOUSE' });

    const scopedUser = {
      userId,
      email: 'kho@local.dev',
      roles: ['warehouse_staff'],
      warehouseIds: [warehouseK2],
    };

    expect(() =>
      inventory.assertWarehouseAccess(scopedUser, warehouseK1),
    ).toThrow(ForbiddenException);

    const onHandBeforeCancel = (
      await prisma.inventoryLevel.findUniqueOrThrow({
        where: { variantId_warehouseId: { variantId, warehouseId: warehouseK1 } },
      })
    ).onHand;

    const { data: stn } = await transferService.create(
      {
        from_warehouse_id: warehouseK1.toString(),
        to_warehouse_id: warehouseK2.toString(),
        items: [
          {
            variant_id: variantId.toString(),
            lot_id: lot.id.toString(),
            quantity: 2,
          },
        ],
      },
      auth,
    );

    const onHandAfterCreate = (
      await prisma.inventoryLevel.findUniqueOrThrow({
        where: { variantId_warehouseId: { variantId, warehouseId: warehouseK1 } },
      })
    ).onHand;
    expect(onHandAfterCreate).toBe(onHandBeforeCancel - 2);

    await transferService.cancel(BigInt(stn.id), auth);

    const cancelled = await prisma.stockTransfer.findUniqueOrThrow({
      where: { id: BigInt(stn.id) },
    });
    expect(cancelled.status).toBe(StockTransferStatus.huy);

    const onHandAfterCancel = (
      await prisma.inventoryLevel.findUniqueOrThrow({
        where: { variantId_warehouseId: { variantId, warehouseId: warehouseK1 } },
      })
    ).onHand;
    expect(onHandAfterCancel).toBe(onHandBeforeCancel);
  });
});

describe('Quickstart KC (unit smoke)', () => {
  it('computeAvailable công thức INV-1', () => {
    expect(
      computeAvailable({ onHand: 10, committed: 3, packing: 0, unavailable: 0 }),
    ).toBe(7);
  });
});
