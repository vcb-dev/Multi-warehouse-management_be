/**
 * Hoàn hàng qua webhook ViettelPost — đi đúng vòng đời kể cả khi VTP nhảy cóc, và nhập kho
 * theo cách của Sapo (hàng về là bán được ngay, đơn không giao lại được).
 * Chạy: RUN_INTEGRATION_TESTS=1 npm test -- test/shipment-return.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { OrderReturnStatus, RestockType, ShipmentStatus } from '@prisma/client';
import { OrdersModule } from '../src/modules/orders/orders.module';
import { VouchersModule } from '../src/modules/vouchers/vouchers.module';
import { FulfillmentsModule } from '../src/modules/fulfillments/fulfillments.module';
import { OrderService } from '../src/modules/orders/order.service';
import { FulfillmentService } from '../src/modules/fulfillments/fulfillment.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { adminAuth } from './helpers/auth';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

const SKU = `SHIP-RETURN-${Date.now()}`;
const STOCK = 100;

jest.setTimeout(120000);

describeIfDb('Hoàn hàng qua webhook VTP', () => {
  let orders: OrderService;
  let fulfillments: FulfillmentService;
  let prisma: PrismaService;
  let locationId: bigint;
  let variantId: bigint;
  let productId: bigint;
  let customerId: bigint;
  let testProviderId: bigint;
  let vtpProviderId: bigint;
  let authUser: ReturnType<typeof adminAuth>;
  let seq = 0;

  async function level() {
    return prisma.inventoryLevel.findUniqueOrThrow({
      where: { variantId_locationId: { variantId, locationId } },
    });
  }

  /** Đơn 2 cái, đã đẩy vận đơn (pending) rồi gắn sang VTP với mã vận đơn giả. */
  async function vtpShipment(qty = 2) {
    const created = await orders.create(
      {
        location_id: locationId.toString(),
        customer_id: customerId.toString(),
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
    const orderId = BigInt(created.id);
    await orders.transition(
      orderId,
      { action: 'processing' },
      authUser as never,
    );
    const f = await fulfillments.createPackingRequest(
      { order_id: orderId.toString() },
      authUser as never,
    );
    await fulfillments.updatePackingStatus(
      BigInt(f.id),
      { status: 'packed' } as never,
      authUser as never,
    );
    const pushed = await fulfillments.pushShipment(
      {
        order_id: orderId.toString(),
        shipping_type: 'tich_hop',
        provider_id: testProviderId.toString(),
        service_code: 'standard',
        weight_grams: 500,
        to_name: 'Người nhận test',
        to_phone: '0900000000',
        to_address: '1 Test',
      } as never,
      authUser as never,
    );
    const tracking = `VTPTEST${Date.now()}${seq++}`;
    await prisma.fulfillment.update({
      where: { id: BigInt(pushed.id) },
      data: { providerId: vtpProviderId, trackingNumber: tracking },
    });
    return { orderId, fulfillmentId: BigInt(pushed.id), tracking };
  }

  const hook = (tracking: string, status: number) =>
    fulfillments.webhookVtp({
      DATA: { ORDER_NUMBER: tracking, ORDER_STATUS: status },
    } as never);

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, VouchersModule, OrdersModule, FulfillmentsModule],
    }).compile();
    orders = module.get(OrderService);
    fulfillments = module.get(FulfillmentService);
    prisma = module.get(PrismaService);

    const warehouse = await prisma.location.findFirstOrThrow();
    locationId = warehouse.id;
    const actor = await prisma.user.findFirstOrThrow({
      where: { active: true },
    });
    authUser = adminAuth({ userId: actor.id, locationIds: [locationId] });

    const product = await prisma.product.create({
      data: { name: `Return ${SKU}`, alias: SKU.toLowerCase() },
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
        onHand: STOCK,
        available: STOCK,
        price: 1000,
        cost: 500,
      },
    });
    const customer = await prisma.customer.create({
      data: { firstName: `KH test ${SKU}`, phone: `+849${Date.now() % 1e8}` },
    });
    customerId = customer.id;

    const provider = await prisma.shippingProvider.create({
      data: {
        code: `return_carrier_${Date.now()}`,
        name: 'Return Test Carrier',
        type: 'tich_hop',
        isConnected: true,
        servicesConfig: [
          {
            code: 'standard',
            name: 'Chuẩn',
            eta: '2-3 ngày',
            base_fee: 40000,
            extra_fee_per_500g: 5000,
          },
        ],
      },
    });
    testProviderId = provider.id;
    const vtp = await prisma.shippingProvider.findUniqueOrThrow({
      where: { code: 'viettel_post' },
    });
    vtpProviderId = vtp.id;
  });

  afterAll(async () => {
    const orderIds = (
      await prisma.orderItem.findMany({
        where: { variantId },
        select: { orderId: true },
      })
    ).map((i) => i.orderId);
    await prisma.orderRefund.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    await prisma.fulfillment.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    await prisma.activityLog.deleteMany({
      where: { entityType: 'order', entityId: { in: orderIds } },
    });
    await prisma.customerLedgerEntry.deleteMany({ where: { customerId } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.customer.delete({ where: { id: customerId } });
    await prisma.inventoryMovement.deleteMany({ where: { variantId } });
    await prisma.inventoryLevel.deleteMany({ where: { variantId } });
    await prisma.productVariant.delete({ where: { id: variantId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.shippingProvider.delete({ where: { id: testProviderId } });
    await prisma.$disconnect();
  });

  it('VTP báo thẳng 504 khi vận đơn còn chờ lấy: đi đủ vòng, hàng về là bán được', async () => {
    const { orderId, fulfillmentId, tracking } = await vtpShipment();
    const before = await level();

    await hook(tracking, 504);

    const f = await prisma.fulfillment.findUniqueOrThrow({
      where: { id: fulfillmentId },
    });
    expect(f.shipmentStatus).toBe(ShipmentStatus.returned);
    expect(f.closedAt).not.toBeNull();

    const after = await level();
    // Xuất kho ở picked_up rồi nhập lại ở returned → on_hand như cũ, nhưng không còn giữ
    // chỗ (committed/packed) cho đơn: 2 cái trở lại "có thể bán".
    expect(after.onHand).toBe(before.onHand);
    expect(after.packed).toBe(before.packed - 2);
    expect(after.committed).toBe(before.committed);
    expect(after.available).toBe(before.available + 2);

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { refunds: { include: { lineItems: true } } },
    });
    expect(order.deliveredOn).toBeNull();
    expect(order.returnStatus).toBe(OrderReturnStatus.returned);
    expect(order.refunds).toHaveLength(1);
    expect(Number(order.refunds[0].totalRefunded)).toBe(0);
    expect(order.refunds[0].lineItems.map((l) => l.restockType)).toEqual([
      RestockType.return_item,
    ]);
  });

  it('đang giao mà VTP báo 502 rồi 504 (không qua 505): vẫn hoàn và nhập kho đúng một lần', async () => {
    const { fulfillmentId, tracking } = await vtpShipment();
    await hook(tracking, 105);
    await hook(tracking, 500);
    const mid = await level();

    await hook(tracking, 502);
    expect(
      (
        await prisma.fulfillment.findUniqueOrThrow({
          where: { id: fulfillmentId },
        })
      ).shipmentStatus,
    ).toBe(ShipmentStatus.returning);
    expect((await level()).onHand).toBe(mid.onHand);

    await hook(tracking, 504);
    // Hành trình trùng/sau trạng thái kết thúc — không được nhập kho lần hai
    await hook(tracking, 504);
    await hook(tracking, 500);

    const after = await level();
    expect(after.onHand).toBe(mid.onHand + 2);
    expect(after.available).toBe(mid.available + 2);
    expect(
      (
        await prisma.fulfillment.findUniqueOrThrow({
          where: { id: fulfillmentId },
        })
      ).shipmentStatus,
    ).toBe(ShipmentStatus.returned);
  });

  it('webhook sai thứ tự (105 đến sau 300) bị bỏ qua, không trừ kho hai lần', async () => {
    const { fulfillmentId, tracking } = await vtpShipment();
    const before = await level();
    await hook(tracking, 300);
    await hook(tracking, 105);
    const after = await level();
    expect(after.onHand).toBe(before.onHand - 2);
    expect(
      (
        await prisma.fulfillment.findUniqueOrThrow({
          where: { id: fulfillmentId },
        })
      ).shipmentStatus,
    ).toBe(ShipmentStatus.delivering);
  });

  it('đơn đã hoàn: không giao lại được; hủy đơn không nhả giữ chỗ lần hai', async () => {
    const { orderId, tracking } = await vtpShipment();
    await hook(tracking, 504);
    const before = await level();

    await expect(
      fulfillments.createPackingRequest(
        { order_id: orderId.toString() },
        authUser as never,
      ),
    ).rejects.toThrow('Đơn đã hoàn hàng về kho');
    await expect(
      orders.transition(orderId, { action: 'ship' }, authUser as never),
    ).rejects.toThrow('Đơn đã hoàn hàng về kho');

    await orders.transition(
      orderId,
      { action: 'cancel', reason: 'khách bom hàng' } as never,
      authUser as never,
    );
    const after = await level();
    expect(after.committed).toBe(before.committed);
    expect(after.available).toBe(before.available);
    expect(after.onHand).toBe(before.onHand);

    const cancelLines = await prisma.orderRefundLineItem.count({
      where: { refund: { orderId }, restockType: RestockType.cancel },
    });
    expect(cancelLines).toBe(0);
  });
});
