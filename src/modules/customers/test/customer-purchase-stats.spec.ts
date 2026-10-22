import { OrderStatus } from '@prisma/client';
import { CustomerService, netCustomerSpent } from './customer.service';

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
    ordersCount: 0,
    totalSpent: 0,
    lastOrderId: null,
    lastOrderName: null,
    note: null,
    tags: [],
    createdOn: new Date('2026-01-01'),
    modifiedOn: new Date('2026-01-01'),
    addresses: [],
    groups: [],
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

describe('CustomerService.findOne — số mua hàng sống', () => {
  it('số đơn bỏ huỷ; chi tiêu = thu − hoàn', async () => {
    const prisma = {
      customer: { findUnique: jest.fn().mockResolvedValue(emptyCustomer()) },
      order: {
        count: jest.fn().mockResolvedValue(2),
        findFirst: jest.fn().mockResolvedValue({ id: 9n, name: '#1009' }),
        findMany: jest.fn().mockResolvedValue([
          { totalReceived: 1_000_000, totalRefunded: null, refunds: [] },
          { totalReceived: 0, totalRefunded: null, refunds: [] },
        ]),
      },
    };
    const svc = new CustomerService(prisma as never, {} as never, {} as never);
    const actual = await svc.findOne(1n);

    expect(actual.data.orders_count).toBe(2);
    expect(actual.data.total_spent).toBe(1_000_000);
    expect(actual.data.last_order_name).toBe('#1009');
    expect(prisma.order.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          customerId: 1n,
          status: { not: OrderStatus.cancelled },
        },
      }),
    );
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { customerId: 1n } }),
    );
  });

  it('404 khi không có khách', async () => {
    const prisma = {
      customer: { findUnique: jest.fn().mockResolvedValue(null) },
      order: {
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const svc = new CustomerService(prisma as never, {} as never, {} as never);
    await expect(svc.findOne(99n)).rejects.toThrow('Không tìm thấy khách hàng');
  });
});
