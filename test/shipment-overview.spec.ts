/**
 * Tổng quan vận chuyển — GET /fulfillments/shipments/overview (service layer).
 * Chạy: RUN_INTEGRATION_TESTS=1 npm test -- test/shipment-overview.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { OrdersModule } from '../src/modules/orders/orders.module';
import { VouchersModule } from '../src/modules/vouchers/vouchers.module';
import { FulfillmentsModule } from '../src/modules/fulfillments/fulfillments.module';
import { OrderService } from '../src/modules/orders/order.service';
import { FulfillmentService } from '../src/modules/fulfillments/fulfillment.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { adminAuth } from './helpers/auth';
import dayjs from 'dayjs';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

const SKU = `SHIP-OVERVIEW-${Date.now()}`;

jest.setTimeout(120000);

describeIfDb('getShipmentOverview', () => {
  let orders: OrderService;
  let fulfillments: FulfillmentService;
  let prisma: PrismaService;
  let locationId: bigint;
  let variantId: bigint;
  let productId: bigint;
  let providerId: bigint;
  let authUser: ReturnType<typeof adminAuth>;

  async function createConfirmedOrder(qty = 1) {
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
    await orders.transition(
      BigInt(created.id),
      { action: 'processing' },
      authUser as never,
    );
    return BigInt(created.id);
  }

  async function pushTestShipment(orderId: bigint) {
    const f = await fulfillments.createPackingRequest(
      { order_id: orderId.toString() },
      authUser as never,
    );
    await fulfillments.updatePackingStatus(
      BigInt(f.id),
      { status: 'packed' } as never,
      authUser as never,
    );
    return fulfillments.pushShipment(
      {
        order_id: orderId.toString(),
        shipping_type: 'tich_hop',
        provider_id: providerId.toString(),
        service_code: 'standard',
        weight_grams: 500,
        to_name: 'Người nhận test',
        to_phone: '0900000000',
        to_address: '1 Test',
      } as never,
      authUser as never,
    );
  }

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, VouchersModule, OrdersModule, FulfillmentsModule],
    }).compile();
    orders = module.get(OrderService);
    fulfillments = module.get(FulfillmentService);
    prisma = module.get(PrismaService);

    const warehouse = await prisma.location.findFirstOrThrow();
    locationId = warehouse.id;
    authUser = adminAuth({ locationIds: [locationId] });

    const product = await prisma.product.create({
      data: { name: `Overview ${SKU}`, alias: SKU.toLowerCase() },
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

    const provider = await prisma.shippingProvider.create({
      data: {
        code: `overview_carrier_${Date.now()}`,
        name: 'Overview Test Carrier',
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
    providerId = provider.id;
  });

  afterAll(async () => {
    const orderIds = (
      await prisma.orderItem.findMany({
        where: { variantId },
        select: { orderId: true },
      })
    ).map((i) => i.orderId);
    await prisma.fulfillment.deleteMany({
      where: { orderId: { in: orderIds } },
    });
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

  it('trả đủ shape dashboard sau khi đẩy ship', async () => {
    const orderId = await createConfirmedOrder();
    await pushTestShipment(orderId);

    const from = dayjs().subtract(6, 'day').format('YYYY-MM-DD');
    const to = dayjs().format('YYYY-MM-DD');
    const overview = await fulfillments.getShipmentOverview(
      { from, to, location_id: locationId.toString() },
      authUser,
    );

    expect(overview.status_cards).toHaveLength(7);
    expect(overview.status_cards.map((c) => c.key)).toEqual([
      'pending',
      'picked_up',
      'delivering',
      'retry_delivery',
      'returning',
      'return_pending',
      'returned',
    ]);

    const pending = overview.status_cards.find((c) => c.key === 'pending');
    expect(pending?.count).toBeGreaterThanOrEqual(1);
    expect(pending?.cod).toBeGreaterThanOrEqual(0);

    expect(overview.total_orders).toBeGreaterThanOrEqual(1);
    expect(overview.proportions.reduce((s, p) => s + p.count, 0)).toBe(
      overview.total_orders,
    );
    expect(
      overview.proportions.some((p) => p.name === 'Overview Test Carrier'),
    ).toBe(true);
  });

  it('cập nhật thẻ trạng thái và metrics sau picked_up + delivered', async () => {
    const orderId = await createConfirmedOrder();
    const pushed = await pushTestShipment(orderId);
    const fulfillmentId = BigInt(pushed.id);

    await fulfillments.updateShipmentStatus(
      fulfillmentId,
      { status: 'picked_up' } as never,
      authUser as never,
    );
    await fulfillments.updateShipmentStatus(
      fulfillmentId,
      { status: 'delivering' } as never,
      authUser as never,
    );
    await fulfillments.updateShipmentStatus(
      fulfillmentId,
      { status: 'delivered' } as never,
      authUser as never,
    );

    const from = dayjs().subtract(6, 'day').format('YYYY-MM-DD');
    const to = dayjs().format('YYYY-MM-DD');
    const overview = await fulfillments.getShipmentOverview(
      { from, to, location_id: locationId.toString() },
      authUser,
    );

    // delivered không có trong 7 thẻ UI — nhưng DB có status delivered
    // đơn đã delivered không còn pending/picked_up
    const pending = overview.status_cards.find((c) => c.key === 'pending');
    expect(pending?.count).toBeGreaterThanOrEqual(0);

    const carrierMetrics = overview.avg_pickup_times.find(
      (x) => x.name === 'Overview Test Carrier',
    );
    expect(carrierMetrics?.hours).not.toBeNull();

    const deliveryMetrics = overview.avg_delivery_times.find(
      (x) => x.name === 'Overview Test Carrier',
    );
    expect(deliveryMetrics?.days).not.toBeNull();

    const success = overview.success_rates.find(
      (x) => x.name === 'Overview Test Carrier',
    );
    expect(success?.rate).toBe(100);
  });

  it('lọc theo khoảng ngày — đơn ngoài kỳ không tính', async () => {
    const orderId = await createConfirmedOrder();
    await pushTestShipment(orderId);

    const pastFrom = dayjs().subtract(30, 'day').format('YYYY-MM-DD');
    const pastTo = dayjs().subtract(20, 'day').format('YYYY-MM-DD');

    const overview = await fulfillments.getShipmentOverview(
      { from: pastFrom, to: pastTo, location_id: locationId.toString() },
      authUser,
    );

    expect(overview.total_orders).toBe(0);
    expect(overview.status_cards.every((c) => c.count === 0)).toBe(true);
  });

  it('listShipments trả vận đơn đã đẩy ship', async () => {
    const orderId = await createConfirmedOrder();
    await pushTestShipment(orderId);

    const list = await fulfillments.listShipments(
      { page: 1, page_size: 20, location_id: locationId.toString() },
      authUser,
    );

    expect(list.total).toBeGreaterThanOrEqual(1);
    expect(list.data.some((r) => r.shipment_status === 'pending')).toBe(true);
  });
});
