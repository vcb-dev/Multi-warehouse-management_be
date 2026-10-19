import { Prisma } from '@prisma/client';
import { OrderService } from './order.service';
import type { AuthUser } from '../../common/decorators/current-user.decorator';

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

const staff: AuthUser = {
  userId: 8n,
  email: 'staff@example.com',
  roles: ['staff'],
  locationIds: [1n],
  isAdmin: false,
  warehousePermissions: { '1': ['order:update'] },
};

function setup({ committed = 10 }: { committed?: number } = {}) {
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
        variantId: 100n,
        name: 'Túi xách',
        variantTitle: null,
        note: null,
        sku: 'TUI-01',
        quantity: 2,
        price: 100_000,
        totalDiscount: 0,
        costPrice: null,
      },
    ],
  };
  const tx = {
    orderItem: {
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({}),
    },
    inventoryLevel: {
      findUnique: jest.fn().mockResolvedValue({ committed }),
    },
    order: { update: jest.fn().mockResolvedValue({ id: 1n, items: [] }) },
    activityLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const repo = {
    findById: jest.fn().mockResolvedValue(order),
    client: {
      $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
      productVariant: {
        findUnique: jest.fn().mockResolvedValue({
          id: 200n,
          sku: 'KHAN-01',
          title: 'Default Title',
          cost: new Prisma.Decimal(40_000),
          product: { name: 'Khăn lụa' },
        }),
      },
    },
  };
  const inventory = { applyMovement: jest.fn().mockResolvedValue({}) };
  const pricing = {
    resolvePrice: jest.fn().mockResolvedValue({ price: 150_000 }),
    listedPrices: jest.fn().mockResolvedValue([100_000]),
  };
  const service = new OrderService(
    repo as never,
    inventory as never,
    pricing as never,
    null as never,
    null as never,
    null as never,
  );
  return { service, tx, inventory, pricing };
}

describe('OrderService.update — thêm/bớt dòng hàng khi sửa đơn', () => {
  it('thêm dòng mới theo giá niêm yết của kho và giữ chỗ tồn', async () => {
    const { service, tx, inventory } = setup();

    await service.update(
      1n,
      {
        line_items: [
          { id: '10', quantity: 2 },
          { variant_id: '200', quantity: 1 },
        ],
      },
      admin,
    );

    expect(tx.orderItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 1n,
        variantId: 200n,
        name: 'Khăn lụa',
        variantTitle: null,
        sku: 'KHAN-01',
        quantity: 1,
        price: 150_000,
        discountedTotal: 150_000,
      }),
    });
    expect(tx.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(inventory.applyMovement).toHaveBeenCalledTimes(1);
    expect(inventory.applyMovement).toHaveBeenCalledWith(
      expect.objectContaining({
        variantId: 200n,
        bucket: 'committed',
        change: 1,
        type: 'order_reserve',
      }),
      tx,
    );
    expect(tx.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subTotalPrice: 350_000,
          totalPrice: 350_000,
          subtotalLineItemsQuantity: 3,
        }),
      }),
    );
  });

  it('xoá dòng không còn trong danh sách và nhả tồn giữ chỗ', async () => {
    const { service, tx, inventory } = setup();

    await service.update(
      1n,
      { line_items: [{ variant_id: '200', quantity: 1 }] },
      admin,
    );

    expect(tx.orderItem.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [10n] } },
    });
    expect(inventory.applyMovement).toHaveBeenCalledWith(
      expect.objectContaining({
        variantId: 100n,
        change: -2,
        type: 'order_release',
      }),
      tx,
    );
  });

  it('nhả không quá số đang giữ chỗ (đơn cũ chưa từng giữ chỗ)', async () => {
    const { service, inventory } = setup({ committed: 0 });

    await service.update(
      1n,
      { line_items: [{ id: '10', quantity: 1 }] },
      admin,
    );

    expect(inventory.applyMovement).not.toHaveBeenCalled();
  });

  it('đổi số lượng dòng cũ chỉ giữ thêm phần chênh lệch', async () => {
    const { service, tx, inventory } = setup();

    await service.update(
      1n,
      { line_items: [{ id: '10', quantity: 5 }] },
      admin,
    );

    expect(tx.orderItem.update).toHaveBeenCalledWith({
      where: { id: 10n },
      data: expect.objectContaining({
        quantity: 5,
        price: 100_000,
        discountedTotal: 500_000,
      }),
    });
    expect(inventory.applyMovement).toHaveBeenCalledWith(
      expect.objectContaining({ variantId: 100n, change: 3 }),
      tx,
    );
  });

  it('không cho bỏ hết sản phẩm khỏi đơn', async () => {
    const { service } = setup();

    await expect(
      service.update(1n, { line_items: [] }, admin),
    ).rejects.toMatchObject({
      message: 'Đơn phải có ít nhất một dòng',
    });
  });

  it('không có quyền sửa giá thì không được đổi giá dòng cũ', async () => {
    const { service, tx } = setup();

    await expect(
      service.update(
        1n,
        { line_items: [{ id: '10', quantity: 2, price: 80_000 }] },
        staff,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it('không có quyền sửa giá vẫn đổi được số lượng dòng cũ', async () => {
    const { service, pricing } = setup();

    await service.update(
      1n,
      { line_items: [{ id: '10', quantity: 3 }] },
      staff,
    );

    expect(pricing.listedPrices).not.toHaveBeenCalled();
  });

  it('không nhận line_items cùng items', async () => {
    const { service } = setup();

    await expect(
      service.update(
        1n,
        {
          items: [{ id: '10', discount: 0 }],
          line_items: [{ id: '10', quantity: 2 }],
        },
        admin,
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});
