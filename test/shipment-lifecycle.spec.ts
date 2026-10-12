/**
 * Vòng đời vận đơn và ảnh hưởng lên đơn hàng + tồn kho, theo cách Sapo làm.
 * Tích hợp, ghi vào DB thật — tự tạo dữ liệu riêng và xoá sạch ở afterAll.
 * Chạy: set -a; . ./.env; set +a; RUN_INTEGRATION_TESTS=1 npx jest test/shipment-lifecycle.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { OrdersModule } from '../src/modules/orders/orders.module';
import { VouchersModule } from '../src/modules/vouchers/vouchers.module';
import { FulfillmentsModule } from '../src/modules/fulfillments/fulfillments.module';
import { OrderReturnsModule } from '../src/modules/order-returns/order-returns.module';
import { OrderService } from '../src/modules/orders/order.service';
import { FulfillmentService } from '../src/modules/fulfillments/fulfillment.service';
import { CodReconciliationService } from '../src/modules/fulfillments/cod-reconciliation.service';
import { OrderReturnService } from '../src/modules/order-returns/order-return.service';
import { NotificationService } from '../src/modules/notifications/notification.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { adminAuth } from './helpers/auth';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

const SKU = `SHIP-LIFE-${Date.now()}`;
const PRICE = 1000;
const QTY = 2;

jest.setTimeout(120000);

describeIfDb('Vòng đời vận đơn theo Sapo', () => {
  let orders: OrderService;
  let fulfillments: FulfillmentService;
  let cod: CodReconciliationService;
  let returns: OrderReturnService;
  let prisma: PrismaService;
  let locationId: bigint;
  let variantId: bigint;
  let productId: bigint;
  let customerId: bigint;
  let providerId: bigint;
  let user: never;

  async function confirmedOrder() {
    const created = await orders.create(
      {
        location_id: locationId.toString(),
        customer_id: customerId.toString(),
        items: [
          {
            variant_id: variantId.toString(),
            location_id: locationId.toString(),
            quantity: QTY,
            price: PRICE,
          },
        ],
      } as never,
      user,
    );
    const id = BigInt(created.id);
    await orders.transition(id, { action: 'processing' }, user);
    return id;
  }

  const push = (orderId: bigint, extra: Record<string, unknown> = {}) =>
    fulfillments.pushShipment(
      {
        order_id: orderId.toString(),
        shipping_type: 'tich_hop',
        provider_id: providerId.toString(),
        service_code: 'standard',
        weight_grams: 500,
        to_name: 'Người nhận test',
        to_phone: '0900000000',
        to_address: '1 Test',
        ...extra,
      } as never,
      user,
    );

  const move = (fulfillmentId: string, status: string) =>
    fulfillments.updateShipmentStatus(
      BigInt(fulfillmentId),
      { status } as never,
      user,
    );

  async function deliver(fulfillmentId: string) {
    await move(fulfillmentId, 'picked_up');
    await move(fulfillmentId, 'delivering');
    await move(fulfillmentId, 'delivered');
  }

  const order = (id: bigint) =>
    prisma.order.findUniqueOrThrow({ where: { id } });

  const level = () =>
    prisma.inventoryLevel.findUniqueOrThrow({
      where: { variantId_locationId: { variantId, locationId } },
    });

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        VouchersModule,
        OrdersModule,
        FulfillmentsModule,
        OrderReturnsModule,
      ],
    })
      // Không để test rải thông báo vào chuông của người dùng thật
      .overrideProvider(NotificationService)
      .useValue({ emit: jest.fn().mockResolvedValue(undefined) })
      .compile();
    orders = module.get(OrderService);
    fulfillments = module.get(FulfillmentService);
    cod = module.get(CodReconciliationService);
    returns = module.get(OrderReturnService);
    prisma = module.get(PrismaService);

    locationId = (await prisma.location.findFirstOrThrow()).id;
    const actor = await prisma.user.findFirstOrThrow({
      where: { active: true },
    });
    user = adminAuth({ userId: actor.id, locationIds: [locationId] }) as never;

    productId = (
      await prisma.product.create({
        data: { name: `Ship life ${SKU}`, alias: SKU.toLowerCase() },
      })
    ).id;
    variantId = (
      await prisma.productVariant.create({
        data: {
          productId,
          sku: SKU,
          title: 'default',
          price: PRICE,
          cost: 500,
        },
      })
    ).id;
    await prisma.inventoryLevel.create({
      data: {
        variantId,
        locationId,
        onHand: 100,
        available: 100,
        price: PRICE,
        cost: 500,
      },
    });
    customerId = (
      await prisma.customer.create({ data: { firstName: `KH ${SKU}` } })
    ).id;
    providerId = (
      await prisma.shippingProvider.create({
        data: {
          code: `life_carrier_${Date.now()}`,
          name: 'Lifecycle Test Carrier',
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
      })
    ).id;
  });

  afterAll(async () => {
    const orderIds = (
      await prisma.orderItem.findMany({
        where: { variantId },
        select: { orderId: true },
      })
    ).map((i) => i.orderId);
    const returnIds = (
      await prisma.orderReturn.findMany({
        where: { orderId: { in: orderIds } },
        select: { id: true },
      })
    ).map((r) => r.id);
    await prisma.voucher.deleteMany({
      where: { referenceType: 'order', referenceId: { in: orderIds } },
    });
    await prisma.voucher.deleteMany({
      where: { referenceType: 'order_return', referenceId: { in: returnIds } },
    });
    await prisma.activityLog.deleteMany({
      where: { entityType: 'order', entityId: { in: orderIds } },
    });
    await prisma.activityLog.deleteMany({
      where: { entityType: 'order_return', entityId: { in: returnIds } },
    });
    await prisma.orderRefund.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    await prisma.orderReturn.deleteMany({ where: { id: { in: returnIds } } });
    await prisma.fulfillment.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.customerLedgerEntry.deleteMany({ where: { customerId } });
    await prisma.customer.delete({ where: { id: customerId } });
    await prisma.inventoryMovement.deleteMany({ where: { variantId } });
    await prisma.inventoryLevel.deleteMany({ where: { variantId } });
    await prisma.productVariant.delete({ where: { id: variantId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.shippingProvider.delete({ where: { id: providerId } });
    await prisma.$disconnect();
  });

  it('có kiện hàng là đơn "đã xuất kho"; huỷ kiện thì trở lại chưa xuất kho', async () => {
    const id = await confirmedOrder();
    expect((await order(id)).fulfillmentStatus).toBeNull();

    const packing = await fulfillments.createPackingRequest(
      { order_id: id.toString() },
      user,
    );
    expect((await order(id)).fulfillmentStatus).toBe('fulfilled');

    await fulfillments.cancel(BigInt(packing.id), {} as never, user);
    expect((await order(id)).fulfillmentStatus).toBeNull();
  });

  it('đẩy vận chuyển thẳng: kiện ở "chờ đóng gói", có hình thức giao hàng', async () => {
    const id = await confirmedOrder();
    const pushed = await push(id);

    expect(pushed).toMatchObject({
      shipment_status: 'pending',
      packed_status: 'unknown',
      delivery_method: 'external_service',
    });
    expect((await order(id)).fulfillmentStatus).toBe('fulfilled');

    // Kiện đẩy thẳng vẫn đóng gói được: hàng sang khu đóng gói rồi mới rời kho
    const before = await level();
    await fulfillments.updatePackingStatus(
      BigInt(pushed.id),
      { status: 'packed' } as never,
      user,
    );
    const packed = await level();
    expect(packed.packed).toBe(before.packed + QTY);
    expect(packed.committed).toBe(before.committed - QTY);

    await move(pushed.id, 'picked_up');
    const picked = await level();
    expect(picked.packed).toBe(before.packed);
    expect(picked.onHand).toBe(before.onHand - QTY);
  });

  it('giao xong mà chưa thu tiền thì đơn vẫn mở; đối soát COD mới hoàn thành', async () => {
    const id = await confirmedOrder();
    const pushed = await push(id, { cod_amount: QTY * PRICE });

    await expect(cod.reconcile(BigInt(pushed.id), user)).rejects.toThrow(
      'Chỉ đối soát vận đơn đã giao thành công',
    );

    await deliver(pushed.id);
    expect(await order(id)).toMatchObject({
      status: 'open',
      fulfillmentStatus: 'fulfilled',
      financialStatus: 'pending',
      closedOn: null,
    });

    const result = await cod.reconcile(BigInt(pushed.id), user);
    expect(result.collected).toBe(QTY * PRICE);
    const done = await order(id);
    expect(done).toMatchObject({ status: 'closed', financialStatus: 'paid' });
    expect(Number(done.totalReceived)).toBe(QTY * PRICE);
    expect(done.closedOn).not.toBeNull();

    await expect(cod.reconcile(BigInt(pushed.id), user)).rejects.toThrow(
      'Vận đơn đã đối soát',
    );
    // Báo "đã hoàn thành" chứ không phải "chưa xác nhận"
    await expect(
      orders.transition(id, { action: 'complete' }, user),
    ).rejects.toThrow('Đơn hàng đã hoàn thành');
  });

  it('đã thu đủ tiền trước: giao xong là đơn hoàn thành ngay', async () => {
    const id = await confirmedOrder();
    await orders.pay(id, {}, user);
    const pushed = await push(id);
    expect((await order(id)).status).toBe('open');

    await deliver(pushed.id);
    expect(await order(id)).toMatchObject({
      status: 'closed',
      fulfillmentStatus: 'fulfilled',
      financialStatus: 'paid',
    });
  });

  it('thanh toán tay sau khi giao xong cũng hoàn thành đơn', async () => {
    const id = await confirmedOrder();
    const pushed = await push(id);
    await deliver(pushed.id);

    await orders.pay(id, { amount: PRICE }, user);
    expect((await order(id)).status).toBe('open');
    await orders.pay(id, {}, user);
    expect((await order(id)).status).toBe('closed');
  });

  it('đơn đang giao không lọt vào "Đã hoàn thành" và không trả hàng được', async () => {
    const id = await confirmedOrder();
    const pushed = await push(id);
    await move(pushed.id, 'picked_up');

    const name = (await order(id)).name;
    const completed = await orders.list(
      { status: 'closed', q: name } as never,
      user,
    );
    expect(completed.total).toBe(0);
    await expect(
      returns.create(
        {
          order_id: id.toString(),
          refund_amount: 0,
          items: [
            {
              variant_id: variantId.toString(),
              location_id: locationId.toString(),
              quantity: 1,
              price: PRICE,
            },
          ],
        } as never,
        user,
      ),
    ).rejects.toThrow('Đơn đang giao hàng — chỉ trả hàng sau khi giao xong');

    await move(pushed.id, 'delivering');
    await move(pushed.id, 'delivered');
    const after = await orders.list(
      { status: 'closed', q: name } as never,
      user,
    );
    expect(after.total).toBe(1);
  });

  it('hàng hoàn về: đơn vẫn mở và vẫn "đã xuất kho" như Sapo', async () => {
    const id = await confirmedOrder();
    const before = await level();
    const pushed = await push(id);
    await move(pushed.id, 'picked_up');
    await move(pushed.id, 'delivering');
    await move(pushed.id, 'retry_delivery');
    await move(pushed.id, 'returning');
    await move(pushed.id, 'returned');

    expect(await order(id)).toMatchObject({
      status: 'open',
      fulfillmentStatus: 'fulfilled',
      returnStatus: 'returned',
    });
    const after = await level();
    expect(after.onHand).toBe(before.onHand);
    expect(after.committed).toBe(before.committed - QTY);
    await expect(push(id)).rejects.toThrow(/Đơn đã hoàn hàng về kho/);
  });
});
