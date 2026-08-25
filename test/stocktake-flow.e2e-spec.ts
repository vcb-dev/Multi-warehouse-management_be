/**
 * Luồng kiểm hàng: tạo phiếu → ghi số đếm → cân bằng → tồn khớp số đếm.
 * Chạy: RUN_INTEGRATION_TESTS=1 npm test -- test/stocktake-flow.e2e-spec.ts
 *
 * Test tự tạo product/variant riêng (SKU STOCKTAKE-E2E-*) và dọn sau khi chạy —
 * không đụng dữ liệu sẵn có.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { InventoryBucket, MovementType } from '@prisma/client';
import { InventoryModule } from '../src/modules/inventory/inventory.module';
import { InventoryService } from '../src/modules/inventory/inventory.service';
import { StocktakesModule } from '../src/modules/stocktakes/stocktakes.module';
import { StocktakeService } from '../src/modules/stocktakes/stocktake.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { BusinessException } from '../src/common/exceptions/business.exception';
import { adminAuth } from './helpers/auth';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

const SKU = `STOCKTAKE-E2E-${Date.now()}`;

jest.setTimeout(120000);

describeIfDb('kiểm hàng cân bằng tồn và để lại vết', () => {
  let stocktakes: StocktakeService;
  let inventory: InventoryService;
  let prisma: PrismaService;
  let locationId: bigint;
  let variantId: bigint;
  let productId: bigint;
  let authUser: ReturnType<typeof adminAuth>;

  const level = () =>
    prisma.inventoryLevel.findUniqueOrThrow({
      where: { variantId_locationId: { variantId, locationId } },
    });

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, InventoryModule, StocktakesModule],
    }).compile();
    stocktakes = module.get(StocktakeService);
    inventory = module.get(InventoryService);
    prisma = module.get(PrismaService);

    const warehouse = await prisma.location.findFirstOrThrow();
    const user = await prisma.user.findFirstOrThrow();
    locationId = warehouse.id;
    authUser = adminAuth({ userId: user.id, locationIds: [locationId] });

    const product = await prisma.product.create({
      data: { name: `Stocktake E2E ${SKU}`, alias: SKU.toLowerCase() },
    });
    productId = product.id;
    const variant = await prisma.productVariant.create({
      data: { productId, sku: SKU, title: 'default', price: 1000, cost: 500 },
    });
    variantId = variant.id;
    await prisma.inventoryLevel.create({
      data: {
        variantId,
        locationId,
        onHand: 100,
        available: 100,
        price: 1000,
        cost: 500,
      },
    });
  });

  afterAll(async () => {
    const ids = (
      await prisma.stocktakeItem.findMany({
        where: { variantId },
        select: { stocktakeId: true },
      })
    ).map((i) => i.stocktakeId);
    await prisma.activityLog.deleteMany({
      where: { entityType: 'stocktake', entityId: { in: ids } },
    });
    await prisma.stocktake.deleteMany({ where: { id: { in: ids } } });

    await prisma.inventoryMovement.deleteMany({ where: { variantId } });
    await prisma.inventoryLevel.deleteMany({ where: { variantId } });
    await prisma.productVariant.deleteMany({ where: { id: variantId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.$disconnect();
  });

  it('chụp tồn hệ thống lúc tạo phiếu', async () => {
    const { data } = await stocktakes.create(
      {
        location_id: locationId.toString(),
        note: 'kiểm định kỳ',
        items: [{ variant_id: variantId.toString() }],
      },
      authUser,
    );

    expect(data.status).toBe('dang_kiem');
    expect(data.items[0].system_quantity).toBe(100);
    // Chưa đếm ≠ đếm ra 0
    expect(data.items[0].counted_quantity).toBeNull();
    expect(data.items[0].diff_quantity).toBeNull();
  });

  it('cân bằng kéo on_hand về đúng số đếm và ghi movement gắn phiếu', async () => {
    const created = await stocktakes.create(
      {
        location_id: locationId.toString(),
        items: [{ variant_id: variantId.toString(), counted_quantity: 93 }],
      },
      authUser,
    );
    const id = BigInt(created.data.id);

    const { data } = await stocktakes.balance(id, authUser);
    expect(data.status).toBe('da_can_bang');
    expect(data.diff_line_count).toBe(1);
    expect(data.diff_quantity).toBe(-7);

    const after = await level();
    expect(after.onHand).toBe(93);

    const movements = await prisma.inventoryMovement.findMany({
      where: { variantId, referenceType: 'stocktake', referenceId: id },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0].type).toBe('adjust');
    expect(movements[0].change).toBe(-7);
  });

  it('bỏ qua dòng chưa đếm thay vì hiểu là 0', async () => {
    const before = (await level()).onHand;
    const created = await stocktakes.create(
      {
        location_id: locationId.toString(),
        items: [{ variant_id: variantId.toString() }],
      },
      authUser,
    );

    await expect(
      stocktakes.balance(BigInt(created.data.id), authUser),
    ).rejects.toMatchObject({ code: 'STOCKTAKE_NOTHING_COUNTED' });
    expect((await level()).onHand).toBe(before);
  });

  it('phiếu đã cân bằng thì không sửa được nữa', async () => {
    const created = await stocktakes.create(
      {
        location_id: locationId.toString(),
        items: [{ variant_id: variantId.toString(), counted_quantity: 93 }],
      },
      authUser,
    );
    const id = BigInt(created.data.id);
    await stocktakes.balance(id, authUser);

    await expect(
      stocktakes.update(id, { note: 'sửa lại' }, authUser),
    ).rejects.toBeInstanceOf(BusinessException);
  });

  it('đếm thấp hơn phần đang giữ chỗ cho đơn thì báo rõ SKU, không đụng tồn', async () => {
    const current = (await level()).onHand;
    // Giữ chỗ gần hết tồn → số đếm nhỏ hơn phần committed sẽ đẩy available âm.
    // Dùng thẳng movement thay vì tạo đơn: OrderService còn bắt buộc chọn khách hàng,
    // thứ chẳng liên quan gì đến điều đang kiểm ở đây.
    await inventory.applyMovement({
      variantId,
      locationId,
      bucket: InventoryBucket.committed,
      change: current,
      type: MovementType.order_reserve,
      createdById: authUser.userId,
    });

    const created = await stocktakes.create(
      {
        location_id: locationId.toString(),
        items: [{ variant_id: variantId.toString(), counted_quantity: 1 }],
      },
      authUser,
    );

    await expect(
      stocktakes.balance(BigInt(created.data.id), authUser),
    ).rejects.toMatchObject({ code: 'STOCKTAKE_BLOCKED_BY_COMMITTED' });
    // Transaction rollback: tồn giữ nguyên, phiếu vẫn đang kiểm
    expect((await level()).onHand).toBe(current);
    const after = await stocktakes.findOne(BigInt(created.data.id), authUser);
    expect(after.data.status).toBe('dang_kiem');
  });
});
