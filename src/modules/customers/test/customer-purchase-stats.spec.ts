import { OrderStatus } from '@prisma/client';
import { CustomerService } from '../customer.service';
import { netCustomerSpent } from '../helper/net-customer-spent';
import { purchaseStatsFromOrders } from '../helper/purchase-stats';

function emptyCustomer() {
  return {
    id: 1n,
    sapoId: null,
    firstName: 'A',
    lastName: 'B',
    email: null,
    phone: '0900000000',
    company: null,
    state: 'enabled',
    verifiedEmail: false,
    gender: null,
    dob: null,
    acceptsMarketing: false,
    ordersCount: 99,
    totalSpent: 9_999_999,
    lastOrderId: 8n,
    lastOrderName: '#stale',
    note: null,
    tags: [],
    createdOn: new Date('2026-01-01'),
    modifiedOn: new Date('2026-01-01'),
    addresses: [],
    groups: [],
  };
}

function orderRow(
  over: Partial<{
    customerId: bigint;
    status: OrderStatus;
    createdOn: Date;
    id: bigint;
    name: string;
    totalReceived: number;
    totalRefunded: number | null;
    refunds: { totalRefunded: number }[];
  }> = {},
) {
  return {
    customerId: 1n,
    status: OrderStatus.open,
    createdOn: new Date('2026-02-01'),
    id: 2n,
    name: '#1002',
    totalReceived: 0,
    totalRefunded: null,
    refunds: [] as { totalRefunded: number }[],
    ...over,
  };
}

describe('netCustomerSpent', () => {
  it('chưa thu → 0', () => {
    expect(
      netCustomerSpent([
        { totalReceived: 0, totalRefunded: null, refunds: [] },
      ]),
    ).toBe(0);
  });

  it('thu một phần chỉ tính số đã thu', () => {
    expect(
      netCustomerSpent([
        { totalReceived: 400_000, totalRefunded: null, refunds: [] },
      ]),
    ).toBe(400_000);
  });

  it('hoàn OMS trừ trên phiếu refund', () => {
    expect(
      netCustomerSpent([
        {
          totalReceived: 1_000_000,
          totalRefunded: null,
          refunds: [{ totalRefunded: 300_000 }],
        },
      ]),
    ).toBe(700_000);
  });

  it('huỷ đã thu (received = refund) → 0', () => {
    expect(
      netCustomerSpent([
        {
          totalReceived: 1_000_000,
          totalRefunded: null,
          refunds: [{ totalRefunded: 1_000_000 }],
        },
      ]),
    ).toBe(0);
  });

  it('Sapo chỉ có cột total_refunded, không có dòng refund', () => {
    expect(
      netCustomerSpent([
        { totalReceived: 500_000, totalRefunded: 500_000, refunds: [] },
      ]),
    ).toBe(0);
  });
});

describe('purchaseStatsFromOrders', () => {
  it('bỏ đơn huỷ khi đếm; đơn cuối là đơn còn hiệu lực mới nhất', () => {
    const actual = purchaseStatsFromOrders([
      orderRow({
        id: 1n,
        name: '#1001',
        status: OrderStatus.cancelled,
        createdOn: new Date('2026-03-01'),
        totalReceived: 1_000_000,
        refunds: [{ totalRefunded: 1_000_000 }],
      }),
      orderRow({
        id: 2n,
        name: '#1002',
        status: OrderStatus.open,
        createdOn: new Date('2026-02-01'),
        totalReceived: 400_000,
      }),
    ]);
    expect(actual.orders_count).toBe(1);
    expect(actual.total_spent).toBe(400_000);
    expect(actual.last_order_name).toBe('#1002');
  });
});

describe('CustomerService.findOne — số mua hàng sống', () => {
  it('số đơn bỏ huỷ; chi tiêu = thu − hoàn', async () => {
    const prisma = {
      customer: { findUnique: jest.fn().mockResolvedValue(emptyCustomer()) },
      order: {
        findMany: jest.fn().mockResolvedValue([
          orderRow({
            id: 9n,
            name: '#1009',
            status: OrderStatus.closed,
            createdOn: new Date('2026-04-01'),
            totalReceived: 1_000_000,
          }),
          orderRow({
            id: 8n,
            name: '#1008',
            status: OrderStatus.open,
            createdOn: new Date('2026-03-01'),
            totalReceived: 0,
          }),
        ]),
      },
    };
    const svc = new CustomerService(prisma as never, {} as never, {} as never);
    const actual = await svc.findOne(1n);

    expect(actual.data.orders_count).toBe(2);
    expect(actual.data.total_spent).toBe(1_000_000);
    expect(actual.data.last_order_name).toBe('#1009');
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { customerId: 1n } }),
    );
  });

  it('404 khi không có khách', async () => {
    const prisma = {
      customer: { findUnique: jest.fn().mockResolvedValue(null) },
      order: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const svc = new CustomerService(prisma as never, {} as never, {} as never);
    await expect(svc.findOne(99n)).rejects.toThrow('Không tìm thấy khách hàng');
  });
});

describe('CustomerService.list — cùng số mua hàng với chi tiết', () => {
  it('không dùng cột cache Sapo', async () => {
    const prisma = {
      customer: {
        findMany: jest.fn().mockResolvedValue([emptyCustomer()]),
        count: jest.fn().mockResolvedValue(1),
      },
      order: {
        findMany: jest.fn().mockResolvedValue([
          orderRow({
            status: OrderStatus.cancelled,
            totalReceived: 500_000,
            refunds: [{ totalRefunded: 500_000 }],
          }),
          orderRow({
            id: 3n,
            name: '#1003',
            status: OrderStatus.open,
            createdOn: new Date('2026-05-01'),
            totalReceived: 200_000,
          }),
        ]),
      },
    };
    const svc = new CustomerService(prisma as never, {} as never, {} as never);
    const actual = await svc.list({});

    expect(actual.data[0].orders_count).toBe(1);
    expect(actual.data[0].total_spent).toBe(200_000);
    expect(actual.data[0].last_order_name).toBe('#1003');
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { customerId: { in: [1n] } },
      }),
    );
  });
});
