/**
 * Bán âm (backorder giống Sapo): tạo/xác nhận đơn được phép vượt tồn thực tế
 * (available âm) — nhưng "Yêu cầu đóng gói" và "Đẩy vận chuyển" đều bị chặn
 * cứng ở server cho tới khi kho có đủ on_hand; `stock_ready` tính lại mỗi lần
 * đọc đơn nên kho nhập đủ hàng là tự thấy đơn chuyển sang "đủ hàng" ngay,
 * không cần thao tác gì thêm.
 * Chạy: RUN_INTEGRATION_TESTS=1 npm test -- test/oversell-order.e2e-spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { OrdersModule } from '../src/modules/orders/orders.module';
import { VouchersModule } from '../src/modules/vouchers/vouchers.module';
import { FulfillmentsModule } from '../src/modules/fulfillments/fulfillments.module';
import { TransfersModule } from '../src/modules/transfers/transfers.module';
import { OrderService } from '../src/modules/orders/order.service';
import { FulfillmentService } from '../src/modules/fulfillments/fulfillment.service';
import { StockTransferService } from '../src/modules/transfers/stock-transfer.service';
import { InventoryService } from '../src/modules/inventory/inventory.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { BusinessException } from '../src/common/exceptions/business.exception';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

const SKU = `OVERSELL-E2E-${Date.now()}`;
jest.setTimeout(120000);

describeIfDb('bán âm (backorder) — chặn chuyển sang lúc đẩy vận chuyển', () => {
  let orders: OrderService;
  let fulfillments: FulfillmentService;
  let transfers: StockTransferService;
  let inventory: InventoryService;
  let prisma: PrismaService;
  let locationId: bigint;
  let otherWarehouseId: bigint;
  let variantId: bigint;
  let productId: bigint;
  let providerId: bigint;
  let userId: bigint;
  let authUser: { userId: bigint; email: string; roles: string[]; locationIds: bigint[] };

  async function level() {
    return prisma.inventoryLevel.findUniqueOrThrow({
      where: { variantId_locationId: { variantId, locationId } },
    });
  }

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        VouchersModule,
        OrdersModule,
        FulfillmentsModule,
        TransfersModule,
      ],
    }).compile();
    orders = module.get(OrderService);
    fulfillments = module.get(FulfillmentService);
    transfers = module.get(StockTransferService);
    inventory = module.get(InventoryService);
    prisma = module.get(PrismaService);

    const branch = await prisma.location.findFirstOrThrow();
    const warehouses = await prisma.location.findMany({ take: 2 });
    const warehouse = warehouses[0];
    const otherWarehouse = warehouses[1] ?? warehouses[0];
    const user = await prisma.user.findFirstOrThrow();
    locationId = warehouse.id;
    otherWarehouseId = otherWarehouse.id;
    userId = user.id;
    authUser = {
      userId,
      email: 't',
      roles: ['admin'],
      locationIds: [locationId, otherWarehouseId],
    };

    const product = await prisma.product.create({
      data: { name: `Oversell E2E ${SKU}`, alias: SKU.toLowerCase() },
    });
    productId = product.id;
    const variant = await prisma.productVariant.create({
      data: { productId, sku: SKU, title: 'default', price: 1000, cost: 500 },
    });
    variantId = variant.id;
    // Tồn thực tế chỉ có 2, sẽ đặt 5 (vượt 3)
    await prisma.inventoryLevel.create({
      data: { variantId, locationId, onHand: 2, available: 2, price: 1000, cost: 500 },
    });
    if (otherWarehouseId !== locationId) {
      await prisma.inventoryLevel.upsert({
        where: { variantId_locationId: { variantId, locationId: otherWarehouseId } },
        update: { onHand: 0, available: 0 },
        create: {
          variantId,
          locationId: otherWarehouseId,
          onHand: 0,
          available: 0,
          price: 1000,
          cost: 500,
        },
      });
    }

    const provider = await prisma.shippingProvider.create({
      data: {
        code: `oversell_carrier_${Date.now()}`,
        name: 'Oversell Test Carrier',
        type: 'tich_hop',
        isConnected: true,
        servicesConfig: [
          { code: 'standard', name: 'Chuẩn', eta: '2-3 ngày', base_fee: 20000, extra_fee_per_500g: 0 },
        ],
      },
    });
    providerId = provider.id;
  });

  afterAll(async () => {
    const orderIds = (
      await prisma.orderItem.findMany({ where: { variantId }, select: { orderId: true } })
    ).map((i) => i.orderId);
    await prisma.fulfillment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.activityLog.deleteMany({
      where: { entityType: { in: ['order', 'stock_transfer'] } },
    });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.stockTransferItem.deleteMany({ where: { variantId } });
    await prisma.stockTransfer.deleteMany({
      where: { items: { some: { variantId } } },
    });
    await prisma.inventoryMovement.deleteMany({ where: { variantId } });
    await prisma.inventoryLevel.deleteMany({ where: { variantId } });
    await prisma.productVariant.delete({ where: { id: variantId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.shippingProvider.delete({ where: { id: providerId } });
    await prisma.$disconnect();
  });

  it('tạo đơn vượt tồn thành công (available âm), chặn cả đóng gói lẫn đẩy vận chuyển cho tới khi đủ hàng thật', async () => {
    const before = await level();
    expect(before.onHand).toBe(2);

    // 1. Tạo đơn số lượng 5 dù chỉ còn 2 — phải thành công
    const created = await orders.create(
      {
        location_id: locationId.toString(),
        items: [
          {
            variant_id: variantId.toString(),
            location_id: locationId.toString(),
            quantity: 5,
            price: 1000,
          },
        ],
      },
      authUser as never,
    );
    let lv = await level();
    expect(lv.committed).toBe(5);
    expect(lv.available).toBe(2 - 5); // -3, không bị chặn

    const orderId = BigInt(created.id);
    await orders.transition(orderId, { action: 'processing' }, authUser as never);

    // 2. stock_ready phải là false + liệt kê đúng SKU thiếu, ở cả chi tiết lẫn danh sách
    const detailBefore = await orders.findOne(orderId, authUser as never);
    expect(detailBefore.data.stock_ready).toBe(false);
    expect(detailBefore.data.stock_shortage_items).toMatchObject([
      { sku: SKU, required: 5, on_hand: 2 },
    ]);
    const listBefore = await orders.list(
      { page: 1, page_size: 50 } as never,
      authUser as never,
    );
    expect(listBefore.data.find((o) => o.id === created.id)?.stock_ready).toBe(false);

    // 2b. Tab "Thiếu hàng"/"Đủ hàng" phải lọc đúng đơn này
    const thieuHang = await orders.list(
      { stock_status: 'thieu_hang', page: 1, page_size: 50 } as never,
      authUser as never,
    );
    expect(thieuHang.data.some((o) => o.id === created.id)).toBe(true);
    const duHangBefore = await orders.list(
      { stock_status: 'du_hang', page: 1, page_size: 50 } as never,
      authUser as never,
    );
    expect(duHangBefore.data.some((o) => o.id === created.id)).toBe(false);

    // 3. Yêu cầu đóng gói — phải bị CHẶN vì tồn thực tế (2) < số lượng cần (5)
    await expect(
      fulfillments.createPackingRequest({ order_id: created.id }, authUser as never),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });

    // 4. Nhập thêm hàng (receipt) dù available đang âm — KHÔNG được bị chặn
    await inventory.applyMovement({
      variantId,
      locationId,
      bucket: 'on_hand' as never,
      change: 3,
      type: 'receipt' as never,
      referenceType: 'test',
      createdById: userId,
    });
    lv = await level();
    expect(lv.onHand).toBe(5);

    // 5. Giờ đủ hàng thật — stock_ready phải tự chuyển true, không cần thao tác gì thêm
    const detailAfter = await orders.findOne(orderId, authUser as never);
    expect(detailAfter.data.stock_ready).toBe(true);
    expect(detailAfter.data.stock_shortage_items).toEqual([]);

    // 5b. Đơn giờ phải rời khỏi tab "Thiếu hàng" và xuất hiện ở tab "Đủ hàng"
    const thieuHangAfter = await orders.list(
      { stock_status: 'thieu_hang', page: 1, page_size: 50 } as never,
      authUser as never,
    );
    expect(thieuHangAfter.data.some((o) => o.id === created.id)).toBe(false);
    const duHangAfter = await orders.list(
      { stock_status: 'du_hang', page: 1, page_size: 50 } as never,
      authUser as never,
    );
    expect(duHangAfter.data.some((o) => o.id === created.id)).toBe(true);

    // 6. Yêu cầu đóng gói + chuyển đã đóng gói — giờ phải thành công
    const f = await fulfillments.createPackingRequest(
      { order_id: created.id },
      authUser as never,
    );
    await fulfillments.updatePackingStatus(
      BigInt(f.id),
      { status: 'da_dong_goi' } as never,
      authUser as never,
    );
    lv = await level();
    expect(lv.committed).toBe(0);
    expect(lv.packed).toBe(5);
    expect(lv.onHand).toBe(5);

    // 7. Đẩy vận chuyển — phải thành công
    const pushed = await fulfillments.pushShipment(
      {
        order_id: created.id,
        shipping_type: 'tich_hop',
        provider_id: providerId.toString(),
        service_code: 'standard',
        to_name: 'A',
        to_phone: '09',
        to_address: 'B',
      } as never,
      authUser as never,
    );
    expect(pushed.shipment_status).toBe('cho_lay_hang');

    // Dọn: hủy vận đơn để không vướng "fulfillment mở" khi test khác chạy lại
    await fulfillments.cancel(BigInt(pushed.id), {}, authUser as never);
  });

  it('chuyển kho (stock transfer) KHÔNG được phép vượt tồn — vẫn chặn như cũ', async () => {
    // Đặt lại tồn sạch cho biến thể khác warehouse để tránh phụ thuộc test trước
    await prisma.inventoryLevel.update({
      where: { variantId_locationId: { variantId, locationId } },
      data: { onHand: 1, available: 1, committed: 0, packed: 0 },
    });

    const stn = await transfers.create(
      {
        from_location_id: locationId.toString(),
        to_location_id: otherWarehouseId.toString(),
        items: [{ variant_id: variantId.toString(), quantity: 999 }],
      } as never,
      authUser as never,
    );
    const stnId = BigInt((stn as { data: { id: string } }).data.id);
    await expect(
      transfers.transition(stnId, 'submit', authUser as never),
    ).rejects.toThrow();
  });
});
