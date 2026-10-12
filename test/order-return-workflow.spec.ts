/**
 * Phiếu trả hàng theo quy trình (tạo → nhận hàng → hoàn tiền → hoàn thành / huỷ).
 * Tích hợp, ghi vào DB thật — tự tạo sản phẩm riêng và xoá sạch ở afterAll.
 * Chạy: RUN_INTEGRATION_TESTS=1 npx jest test/order-return-workflow.spec.ts
 * (cần DATABASE_URL trong môi trường — biến không tự nạp từ .env).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { OrdersModule } from '../src/modules/orders/orders.module';
import { VouchersModule } from '../src/modules/vouchers/vouchers.module';
import { OrderReturnsModule } from '../src/modules/order-returns/order-returns.module';
import { OrderService } from '../src/modules/orders/order.service';
import { OrderReturnService } from '../src/modules/order-returns/order-return.service';
import { NotificationService } from '../src/modules/notifications/notification.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { adminAuth } from './helpers/auth';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

const SKU = `RETURN-FLOW-${Date.now()}`;
const PRICE = 1000;

jest.setTimeout(120000);

describeIfDb('Phiếu trả hàng theo quy trình', () => {
  let orders: OrderService;
  let returns: OrderReturnService;
  let prisma: PrismaService;
  let locationId: bigint;
  let variantId: bigint;
  let productId: bigint;
  let customerId: bigint;
  let authUser: ReturnType<typeof adminAuth>;

  /** Đơn 2 món đã giao xong — điều kiện để được trả hàng. */
  async function createDeliveredOrder() {
    const created = await orders.create(
      {
        location_id: locationId.toString(),
        customer_id: customerId.toString(),
        items: [
          {
            variant_id: variantId.toString(),
            location_id: locationId.toString(),
            quantity: 2,
            price: PRICE,
          },
        ],
      } as never,
      authUser as never,
    );
    const id = BigInt(created.id);
    await orders.transition(id, { action: 'processing' }, authUser as never);
    await orders.transition(id, { action: 'complete' }, authUser as never);
    return id;
  }

  function returnBody(orderId: bigint, over: Record<string, unknown> = {}) {
    return {
      order_id: orderId.toString(),
      reason_code: 'customer_changed_mind',
      refund_amount: PRICE,
      items: [
        {
          variant_id: variantId.toString(),
          location_id: locationId.toString(),
          quantity: 1,
          price: PRICE,
        },
      ],
      ...over,
    } as never;
  }

  async function onHand() {
    const level = await prisma.inventoryLevel.findFirstOrThrow({
      where: { variantId, locationId },
    });
    return level.onHand;
  }

  async function orderStatuses(orderId: bigint) {
    return prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { returnStatus: true, refundStatus: true, restockStatus: true },
    });
  }

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, VouchersModule, OrdersModule, OrderReturnsModule],
    })
      // Không để test rải thông báo vào chuông của người dùng thật
      .overrideProvider(NotificationService)
      .useValue({ emit: jest.fn().mockResolvedValue(undefined) })
      .compile();
    orders = module.get(OrderService);
    returns = module.get(OrderReturnService);
    prisma = module.get(PrismaService);

    locationId = (await prisma.location.findFirstOrThrow()).id;
    const user = await prisma.user.findFirstOrThrow();
    authUser = adminAuth({ userId: user.id, locationIds: [locationId] });

    customerId = (
      await prisma.customer.create({
        data: { firstName: 'Test trả hàng', lastName: SKU },
      })
    ).id;

    const product = await prisma.product.create({
      data: { name: `Return flow ${SKU}`, alias: SKU.toLowerCase() },
    });
    productId = product.id;
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
      where: { referenceType: 'order_return', referenceId: { in: returnIds } },
    });
    await prisma.voucher.deleteMany({
      where: { referenceType: 'order', referenceId: { in: orderIds } },
    });
    await prisma.activityLog.deleteMany({
      where: { entityType: 'order_return', entityId: { in: returnIds } },
    });
    await prisma.activityLog.deleteMany({
      where: { entityType: 'order', entityId: { in: orderIds } },
    });
    await prisma.orderRefund.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    await prisma.orderReturn.deleteMany({ where: { id: { in: returnIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.customerLedgerEntry.deleteMany({ where: { customerId } });
    await prisma.customer.delete({ where: { id: customerId } });
    await prisma.inventoryMovement.deleteMany({ where: { variantId } });
    await prisma.inventoryLevel.deleteMany({ where: { variantId } });
    await prisma.productVariant.delete({ where: { id: variantId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.$disconnect();
  });

  it('lập phiếu chưa đụng kho, chưa chi tiền; đơn chuyển "đang trả hàng"', async () => {
    const orderId = await createDeliveredOrder();
    const before = await onHand();

    const created = await returns.create(
      returnBody(orderId, { receive_now: false, refund_now: false }),
      authUser as never,
    );
    const doc = await returns.findDocument(
      BigInt(created.id),
      authUser as never,
    );

    expect(doc).toMatchObject({
      status: 'in_progress',
      receive_status: 'not_received',
      restock_status: 'no_restock',
      refund_status: 'no_refund',
      reason_code: 'customer_changed_mind',
      refund_amount: PRICE,
      refunded_amount: 0,
      total_quantity: 1,
      manageable: true,
    });
    expect(created.voucher).toBeNull();
    expect(await onHand()).toBe(before);
    expect(await orderStatuses(orderId)).toMatchObject({
      returnStatus: 'in_progress',
      refundStatus: 'no_refund',
    });
  });

  it('nhận hàng nhập kho, rồi hoàn tiền thì phiếu tự hoàn thành', async () => {
    const orderId = await createDeliveredOrder();
    const before = await onHand();
    const created = await returns.create(
      returnBody(orderId, { receive_now: false, refund_now: false }),
      authUser as never,
    );
    const id = BigInt(created.id);

    const received = await returns.receive(
      id,
      { restock: true },
      authUser as never,
    );
    expect(received).toMatchObject({
      status: 'in_progress',
      receive_status: 'received',
      restock_status: 'restocked',
      refund_status: 'no_refund',
    });
    expect(await onHand()).toBe(before + 1);
    await expect(
      returns.receive(id, { restock: true }, authUser as never),
    ).rejects.toThrow('Phiếu trả đã nhận hàng');

    const partial = await returns.refund(
      id,
      { amount: 400 },
      authUser as never,
    );
    expect(partial).toMatchObject({
      status: 'in_progress',
      refund_status: 'partial',
      refund_remaining: PRICE - 400,
    });
    await expect(
      returns.refund(id, { amount: PRICE }, authUser as never),
    ).rejects.toThrow(/Số tiền hoàn không hợp lệ/);

    const done = await returns.refund(id, {}, authUser as never);
    expect(done).toMatchObject({
      status: 'completed',
      refund_status: 'refunded',
      refunded_amount: PRICE,
    });

    // Một phiếu = một refund: dòng hàng và tiền nằm chung bản ghi
    const refunds = await prisma.orderRefund.findMany({
      where: { returnId: id },
      include: { lineItems: true },
    });
    expect(refunds).toHaveLength(1);
    expect(Number(refunds[0].totalRefunded)).toBe(PRICE);
    expect(refunds[0].lineItems).toHaveLength(1);
    expect(
      await prisma.voucher.count({
        where: { referenceType: 'order_return', referenceId: id },
      }),
    ).toBe(2);
    // Trả 1/2 món và không còn phiếu mở ⇒ vẫn là trả một phần
    expect(await orderStatuses(orderId)).toMatchObject({
      returnStatus: 'in_progress',
      refundStatus: 'partial',
      restockStatus: 'restocked',
    });
    await expect(returns.cancel(id, authUser as never)).rejects.toThrow(
      'Phiếu trả đã hoàn thành hoặc đã hủy',
    );
  });

  it('huỷ phiếu chưa nhận hàng trả đơn về "chưa trả hàng" và nhả số lượng', async () => {
    const orderId = await createDeliveredOrder();
    const body = { receive_now: false, refund_now: false };
    const first = await returns.create(
      returnBody(orderId, {
        ...body,
        refund_amount: 2 * PRICE,
        items: [
          {
            variant_id: variantId.toString(),
            location_id: locationId.toString(),
            quantity: 2,
            price: PRICE,
          },
        ],
      }),
      authUser as never,
    );
    // Phiếu đang mở đã chiếm hết số lượng lẫn số tiền của đơn
    await expect(
      returns.create(returnBody(orderId, body), authUser as never),
    ).rejects.toThrow(/Trả vượt số đã mua/);

    const cancelled = await returns.cancel(BigInt(first.id), authUser as never);
    expect(cancelled.status).toBe('cancelled');
    expect(await orderStatuses(orderId)).toMatchObject({
      returnStatus: 'no_return',
    });
    await expect(
      returns.create(returnBody(orderId, body), authUser as never),
    ).resolves.toMatchObject({ refund_amount: 0 });
  });

  it('không nhập kho: nhận hàng không cộng tồn; chốt phiếu dù chưa hoàn đủ', async () => {
    const orderId = await createDeliveredOrder();
    const before = await onHand();
    const created = await returns.create(
      returnBody(orderId, { receive_now: false, refund_now: false }),
      authUser as never,
    );
    const id = BigInt(created.id);

    await expect(returns.complete(id, authUser as never)).rejects.toThrow(
      'Nhận hàng trước khi hoàn thành phiếu trả',
    );
    const received = await returns.receive(
      id,
      { restock: false },
      authUser as never,
    );
    expect(received.restock_status).toBe('no_restock');
    expect(await onHand()).toBe(before);

    const done = await returns.complete(id, authUser as never);
    expect(done).toMatchObject({
      status: 'completed',
      refund_status: 'no_refund',
    });
  });

  it('client cũ không gửi cờ: lập phiếu là nhận hàng + hoàn tiền ngay như trước', async () => {
    const orderId = await createDeliveredOrder();
    const before = await onHand();

    const created = await returns.create(
      returnBody(orderId),
      authUser as never,
    );
    const doc = await returns.findDocument(
      BigInt(created.id),
      authUser as never,
    );

    expect(created.refund_amount).toBe(PRICE);
    expect(created.voucher).not.toBeNull();
    expect(doc).toMatchObject({
      status: 'completed',
      receive_status: 'received',
      restock_status: 'restocked',
      refund_status: 'refunded',
    });
    expect(await onHand()).toBe(before + 1);
  });

  it('danh sách phiếu lọc được theo trạng thái', async () => {
    const list = await returns.listDocuments(
      { status: 'cancelled', q: 'RTN' } as never,
      authUser as never,
    );
    expect(list.total).toBeGreaterThanOrEqual(1);
    expect(list.data.every((d) => d.status === 'cancelled')).toBe(true);
  });
});
