/**
 * Luồng đóng gói + vận đơn điều khiển trạng thái đơn hàng.
 * Chạy: RUN_INTEGRATION_TESTS=1 npm test -- test/fulfillment-flow.e2e-spec.ts
 *
 * Test tự tạo product/variant/provider riêng (SKU FULFILL-E2E-*) và dọn dẹp
 * sau khi chạy — không đụng dữ liệu sẵn có.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { OrdersModule } from '../src/modules/orders/orders.module';
import { VouchersModule } from '../src/modules/vouchers/vouchers.module';
import { FulfillmentsModule } from '../src/modules/fulfillments/fulfillments.module';
import { OrderService } from '../src/modules/orders/order.service';
import { FulfillmentService } from '../src/modules/fulfillments/fulfillment.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { BusinessException } from '../src/common/exceptions/business.exception';
import { adminAuth } from './helpers/auth';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

const SKU = `FULFILL-E2E-${Date.now()}`;

// DB remote (Supabase) chậm — mỗi test có nhiều roundtrip
jest.setTimeout(120000);

describeIfDb('fulfillment drives order status & inventory buckets', () => {
  let orders: OrderService;
  let fulfillments: FulfillmentService;
  let prisma: PrismaService;
  let locationId: bigint;
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

  async function createConfirmedOrder(qty = 2) {
    const created = await orders.create(
      {
        location_id: locationId.toString(),
        items: [
          {
            variant_id: variantId.toString(),
            location_id: locationId.toString(),
            quantity: qty,
            price: 1000,
          },
        ],
      },
      authUser as never,
    );
    await orders.transition(BigInt(created.id), { action: 'processing' }, authUser as never);
    return BigInt(created.id);
  }

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, VouchersModule, OrdersModule, FulfillmentsModule],
    }).compile();
    orders = module.get(OrderService);
    fulfillments = module.get(FulfillmentService);
    prisma = module.get(PrismaService);

    const warehouse = await prisma.location.findFirstOrThrow();
    const user = await prisma.user.findFirstOrThrow();
    locationId = warehouse.id;
    userId = user.id;
    authUser = adminAuth({ userId, locationIds: [locationId] });

    const product = await prisma.product.create({
      data: { name: `Fulfillment E2E ${SKU}`, alias: SKU.toLowerCase() },
    });
    productId = product.id;
    const variant = await prisma.productVariant.create({
      data: { productId, sku: SKU, title: 'default', price: 1000, cost: 500 },
    });
    variantId = variant.id;
    await prisma.inventoryLevel.create({
      data: { variantId, locationId, onHand: 100, available: 100, price: 1000, cost: 500 },
    });

    const provider = await prisma.shippingProvider.create({
      data: {
        code: `test_carrier_${Date.now()}`,
        name: 'Test Carrier',
        type: 'tich_hop',
        isConnected: true,
        servicesConfig: [
          { code: 'standard', name: 'Chuẩn', eta: '2-3 ngày', base_fee: 40000, extra_fee_per_500g: 5000 },
        ],
      },
    });
    providerId = provider.id;
  });

  afterAll(async () => {
    // Dọn dẹp theo thứ tự FK
    const orderIds = (
      await prisma.orderItem.findMany({ where: { variantId }, select: { orderId: true } })
    ).map((i) => i.orderId);
    await prisma.fulfillment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.activityLog.deleteMany({
      where: { entityType: 'order', entityId: { in: orderIds } },
    });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.inventoryMovement.deleteMany({ where: { variantId } });
    await prisma.inventoryLevel.deleteMany({ where: { variantId } });
    await prisma.productVariant.delete({ where: { id: variantId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.shippingProvider.delete({ where: { id: providerId } });
    await prisma.$disconnect();
  });

  it('happy path: đóng gói → đẩy VC → lấy hàng → giao thành công', async () => {
    const orderId = await createConfirmedOrder(2);
    const before = await level();

    // Yêu cầu đóng gói
    const f = await fulfillments.createPackingRequest(
      { order_id: orderId.toString() },
      authUser as never,
    );
    expect(f.packed_status).toBe('unknown');

    // Đóng gói xong: committed → packing
    await fulfillments.updatePackingStatus(
      BigInt(f.id),
      { status: 'packed' } as never,
      authUser as never,
    );
    let lv = await level();
    expect(lv.committed).toBe(before.committed - 2);
    expect(lv.packed).toBe(before.packed + 2);

    // Chặn thao tác thủ công khi có fulfillment mở
    await expect(
      orders.transition(orderId, { action: 'complete' }, authUser as never),
    ).rejects.toThrow(BusinessException);
    await expect(
      orders.transition(orderId, { action: 'cancel' }, authUser as never),
    ).rejects.toThrow(BusinessException);

    // Đẩy vận chuyển (tích hợp — phí tính server-side)
    const pushed = await fulfillments.pushShipment(
      {
        order_id: orderId.toString(),
        shipping_type: 'tich_hop',
        provider_id: providerId.toString(),
        service_code: 'standard',
        weight_grams: 1200,
        to_name: 'Người nhận',
        to_phone: '0900000000',
        to_address: '1 Test',
      } as never,
      authUser as never,
    );
    expect(pushed.shipment_status).toBe('pending');
    // 1200g = 3 nấc 500g → base + 2 * extra
    expect(pushed.shipping_fee).toBe(40000 + 2 * 5000);

    // ĐTVC lấy hàng (Sapo `picked_up`): on_hand −2, packed −2
    await fulfillments.updateShipmentStatus(
      BigInt(f.id),
      { status: 'picked_up' } as never,
      authUser as never,
    );
    lv = await level();
    expect(lv.onHand).toBe(before.onHand - 2);
    expect(lv.packed).toBe(before.packed);
    const shipped = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(shipped.deliveredOn).not.toBeNull();

    // Bắt đầu giao → không đụng tồn kho
    await fulfillments.updateShipmentStatus(
      BigInt(f.id),
      { status: 'delivering' } as never,
      authUser as never,
    );

    // Giao thành công → đơn closed, fulfillment đóng
    await fulfillments.updateShipmentStatus(
      BigInt(f.id),
      { status: 'delivered' } as never,
      authUser as never,
    );
    const done = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(done.status).toBe('closed');
    const closed = await prisma.fulfillment.findUniqueOrThrow({ where: { id: BigInt(f.id) } });
    expect(closed.closedAt).not.toBeNull();
  });

  it('chuyển hoàn: giao lỗi → hoàn về kho, đơn đẩy lại được rồi hủy', async () => {
    const orderId = await createConfirmedOrder(1);
    const before = await level();

    const pushed = await fulfillments.pushShipment(
      {
        order_id: orderId.toString(),
        shipping_type: 'tich_hop',
        provider_id: providerId.toString(),
        service_code: 'standard',
        to_name: 'A',
        to_phone: '09',
        to_address: 'B',
      } as never,
      authUser as never,
    );
    await fulfillments.updateShipmentStatus(
      BigInt(pushed.id), { status: 'picked_up' } as never, authUser as never);
    await fulfillments.updateShipmentStatus(
      BigInt(pushed.id), { status: 'delivering' } as never, authUser as never);
    await fulfillments.updateShipmentStatus(
      BigInt(pushed.id), { status: 'retry_delivery' } as never, authUser as never);
    await fulfillments.updateShipmentStatus(
      BigInt(pushed.id), { status: 'returning' } as never, authUser as never);
    await fulfillments.updateShipmentStatus(
      BigInt(pushed.id), { status: 'returned' } as never, authUser as never);

    // Tồn về như trước khi lấy hàng (on_hand +1 trả lại, committed giữ chỗ lại)
    const lv = await level();
    expect(lv.onHand).toBe(before.onHand);
    expect(lv.committed).toBe(before.committed);

    const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    // "processing" cũ = status open & đã xác nhận (confirmedOn khác null)
    expect(o.status).toBe('open');
    expect(o.confirmedOn).not.toBeNull();
    expect(o.deliveredOn).toBeNull();

    // Fulfillment đã đóng → giờ hủy đơn được (giải phóng committed)
    await orders.transition(orderId, { action: 'cancel' }, authUser as never);
    const after = await level();
    expect(after.committed).toBe(before.committed - 1);
  });

  it('hủy vận đơn khi đã đóng gói: packing trả về committed', async () => {
    const orderId = await createConfirmedOrder(1);
    const before = await level();

    const f = await fulfillments.createPackingRequest(
      { order_id: orderId.toString() }, authUser as never);
    await fulfillments.updatePackingStatus(
      BigInt(f.id), { status: 'packed' } as never, authUser as never);

    await fulfillments.cancel(BigInt(f.id), {}, authUser as never);
    const lv = await level();
    expect(lv.packed).toBe(before.packed);
    expect(lv.committed).toBe(before.committed);

    // Không còn fulfillment mở → hủy đơn OK
    await orders.transition(orderId, { action: 'cancel' }, authUser as never);
  });

  it('chặn đóng gói khi đơn chưa xác nhận', async () => {
    const created = await orders.create(
      {
        location_id: locationId.toString(),
        items: [
          {
            variant_id: variantId.toString(),
            location_id: locationId.toString(),
            quantity: 1,
            price: 1000,
          },
        ],
      },
      authUser as never,
    );
    await expect(
      fulfillments.createPackingRequest({ order_id: created.id }, authUser as never),
    ).rejects.toThrow(BusinessException);
    await orders.transition(BigInt(created.id), { action: 'cancel' }, authUser as never);
  });
});
