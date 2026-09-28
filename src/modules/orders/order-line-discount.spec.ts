import { OrderService } from './order.service';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import type { UpdateOrderDto } from './order.dto';

jest.mock('./order.serializer', () => ({
  ...jest.requireActual('./order.serializer'),
  serializeOrderDetail: (order: unknown) => order,
}));

const admin: AuthUser = {
  userId: 7n,
  email: 'admin@example.com',
  roles: ['admin'],
  locationIds: [],
  isAdmin: true,
};

function setup(overrides: Record<string, unknown> = {}) {
  const order = {
    id: 1n,
    name: 'DH0001',
    locationId: 1n,
    status: 'open',
    confirmedOn: null,
    subTotalPrice: 200_000,
    totalDiscounts: 0,
    totalShippingPrice: 0,
    totalTax: 0,
    totalPrice: 200_000,
    totalReceived: 0,
    customerId: null,
    items: [
      {
        id: 10n,
        sku: 'TUI-01',
        quantity: 2,
        price: 100_000,
        totalDiscount: 0,
      },
    ],
    ...overrides,
  };
  const itemUpdate = jest.fn().mockResolvedValue({});
  const orderUpdate = jest.fn().mockResolvedValue({ id: 1n, items: [] });
  const activityCreate = jest.fn().mockResolvedValue({});
  const tx = {
    orderItem: { update: itemUpdate },
    order: { update: orderUpdate },
    activityLog: { create: activityCreate },
  };
  const transaction = jest.fn((fn: (client: typeof tx) => unknown) => fn(tx));
  const repo = {
    findById: jest.fn().mockResolvedValue(order),
    client: { $transaction: transaction },
  };
  const service = new OrderService(
    repo as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );

  return { service, itemUpdate, orderUpdate, transaction };
}

describe('OrderService.update — giảm giá dòng sản phẩm', () => {
  it('lưu giảm giá dòng và tính lại tổng đơn', async () => {
    const { service, itemUpdate, orderUpdate } = setup();
    const dto: UpdateOrderDto = {
      items: [{ id: '10', discount: 30_000 }],
    };

    await service.update(1n, dto, admin);

    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: 10n },
      data: { totalDiscount: 30_000, discountedTotal: 170_000 },
    });
    expect(orderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1n },
        data: expect.objectContaining({
          subTotalPrice: 170_000,
          totalPrice: 170_000,
        }),
      }),
    );
  });

  it('giữ nguyên thuế suất khi không gửi tax_rate', async () => {
    // Đơn cũ: 200k tiền hàng, thuế 10% = 20k
    const { service, orderUpdate } = setup({
      totalTax: 20_000,
      totalPrice: 220_000,
    });

    await service.update(
      1n,
      { items: [{ id: '10', discount: 30_000 }] },
      admin,
    );

    expect(orderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subTotalPrice: 170_000,
          totalTax: 17_000,
          totalPrice: 187_000,
        }),
      }),
    );
  });

  it('chặn giảm giá lớn hơn tiền của dòng', async () => {
    const { service, transaction } = setup();

    await expect(
      service.update(1n, { items: [{ id: '10', discount: 200_001 }] }, admin),
    ).rejects.toThrow('không được vượt quá tiền hàng');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('không cho sửa dòng thuộc đơn khác', async () => {
    const { service, transaction } = setup();

    await expect(
      service.update(1n, { items: [{ id: '999', discount: 10_000 }] }, admin),
    ).rejects.toThrow('không thuộc đơn hàng này');
    expect(transaction).not.toHaveBeenCalled();
  });
});
