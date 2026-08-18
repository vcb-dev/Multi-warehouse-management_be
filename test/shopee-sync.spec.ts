import { OrderSource } from '@prisma/client';
import { ShopeeSyncService } from '../src/modules/channels/shopee/shopee-sync.service';

describe('ShopeeSyncService', () => {
  const locationId = BigInt(1);
  const createdById = BigInt(1);
  const conn = {
    id: BigInt(10),
    channel: OrderSource.shopee,
    shopId: '227834954',
    shopName: 'sandbox-shop',
    accessToken: 'access',
    accessTokenExpiresAt: new Date(Date.now() + 3600_000),
    refreshToken: 'refresh',
    refreshTokenExpiresAt: new Date(Date.now() + 86400_000),
    grantedScopes: [],
    locationId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const orderRow = {
    id: BigInt(100),
    name: '240101ABC',
  };

  const tx = {
    order: {
      update: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: BigInt(100) }),
    },
    orderItem: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
  };

  const prisma = {
    channelConnection: {
      findMany: jest.fn().mockResolvedValue([conn]),
      findFirst: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    order: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    productVariant: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: BigInt(99),
          sku: 'SKU-1',
          productId: BigInt(1),
          cost: 10,
        },
      ]),
    },
    customer: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: BigInt(5) }),
    },
    location: {
      findFirst: jest.fn(),
    },
    channelSkuGap: {
      upsert: jest.fn(),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<void>) =>
      fn(tx),
    ),
  };

  const client = {
    getOrderList: jest.fn().mockResolvedValue({
      order_list: [{ order_sn: '240101ABC', order_status: 'READY_TO_SHIP' }],
      more: false,
    }),
    getOrderDetail: jest.fn().mockResolvedValue({
      order_list: [
        {
          order_sn: '240101ABC',
          order_status: 'READY_TO_SHIP',
          create_time: 1704067200,
          update_time: 1704067200,
          total_amount: 150000,
          cod: false,
          item_list: [
            {
              item_name: 'Item',
              model_sku: 'SKU-1',
              model_quantity_purchased: 2,
              model_original_price: 50000,
              model_discounted_price: 45000,
            },
          ],
          recipient_address: { name: 'Buyer', phone: '0901234567' },
        },
      ],
    }),
  };

  const shopeeAuth = {
    getClient: jest.fn().mockReturnValue(client),
    ensureFreshConnection: jest.fn().mockResolvedValue(conn),
  };

  const service = new ShopeeSyncService(prisma as never, shopeeAuth as never);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.channelConnection.findMany.mockResolvedValue([conn]);
    prisma.order.findUnique.mockResolvedValue(null);
    prisma.productVariant.findMany.mockResolvedValue([
      {
        id: BigInt(99),
        sku: 'SKU-1',
        productId: BigInt(1),
        cost: 10,
      },
    ]);
    shopeeAuth.ensureFreshConnection.mockResolvedValue(conn);
    tx.order.create.mockResolvedValue({ id: BigInt(100) });
  });

  it('kéo đơn Shopee và upsert order với mã order_sn', async () => {
    const result = await service.syncShopeeOrders(createdById);

    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(client.getOrderList).toHaveBeenCalled();
    expect(tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: '240101ABC',
          sourceName: 'shopee',
          locationId,
          createdById,
        }),
      }),
    );
    expect(tx.orderItem.createMany).toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({
      order_sn: '240101ABC',
      order_id: '100',
      created: true,
    });
  });

  it('cập nhật đơn đã tồn tại theo name', async () => {
    prisma.order.findUnique.mockResolvedValue(orderRow);

    const result = await service.syncShopeeOrders(createdById);

    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(tx.order.update).toHaveBeenCalled();
    expect(tx.order.create).not.toHaveBeenCalled();
    expect(tx.orderItem.deleteMany).toHaveBeenCalled();
  });

  it('đồng bộ đơn huỷ với status cancelled', async () => {
    client.getOrderDetail.mockResolvedValue({
      order_list: [
        {
          order_sn: '240101CXL',
          order_status: 'CANCELLED',
          create_time: 1704067200,
          update_time: 1704153600,
          total_amount: 100000,
          cod: false,
          item_list: [
            {
              item_name: 'Item',
              model_sku: 'SKU-1',
              model_quantity_purchased: 1,
              model_original_price: 100000,
              model_discounted_price: 100000,
            },
          ],
          recipient_address: { name: 'Buyer', phone: '0909999999' },
        },
      ],
    });
    client.getOrderList.mockResolvedValue({
      order_list: [{ order_sn: '240101CXL', order_status: 'CANCELLED' }],
      more: false,
    });

    await service.syncShopeeOrders(createdById);

    expect(tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: '240101CXL',
          status: 'cancelled',
        }),
      }),
    );
  });

  it.each([
    ['PROCESSED', null, null],
    ['SHIPPED', 'fulfilled', null],
    ['COMPLETED', 'fulfilled', new Date(1704153600 * 1000)],
  ] as const)(
    'map trạng thái giao hàng %s → fulfillment=%s',
    async (orderStatus, fulfillmentStatus, deliveredOn) => {
      client.getOrderList.mockResolvedValue({
        order_list: [{ order_sn: '240101SHP', order_status: orderStatus }],
        more: false,
      });
      client.getOrderDetail.mockResolvedValue({
        order_list: [
          {
            order_sn: '240101SHP',
            order_status: orderStatus,
            create_time: 1704067200,
            update_time: 1704153600,
            total_amount: 100000,
            cod: false,
            item_list: [
              {
                item_name: 'Item',
                model_sku: 'SKU-1',
                model_quantity_purchased: 1,
                model_original_price: 100000,
                model_discounted_price: 100000,
              },
            ],
            recipient_address: { name: 'Buyer', phone: '0901111111' },
          },
        ],
      });

      await service.syncShopeeOrders(createdById);

      expect(tx.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            fulfillmentStatus,
            deliveredOn,
          }),
        }),
      );
    },
  );
});
