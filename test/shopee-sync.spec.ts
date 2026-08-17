import { OrderSource } from '@prisma/client';
import { ShopeeSyncService } from '../src/modules/channels/shopee/shopee-sync.service';

describe('ShopeeSyncService', () => {
  const locationId = BigInt(1);
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
      findUnique: jest.fn().mockResolvedValue({
        id: BigInt(99),
        sku: 'SKU-1',
        cost: 10,
        product: { name: 'Test product' },
      }),
    },
    customer: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: BigInt(5) }),
    },
    location: {
      findFirst: jest.fn(),
    },
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

  const orders = {
    createFromResolvedItems: jest
      .fn()
      .mockResolvedValue({ id: '100', code: '240101ABC', status: 'open' }),
  };

  const service = new ShopeeSyncService(
    prisma as never,
    shopeeAuth as never,
    orders as never,
  );

  const user = {
    userId: BigInt(1),
    email: 'admin@local.dev',
    roles: ['admin'],
    locationIds: [],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.channelConnection.findMany.mockResolvedValue([conn]);
    prisma.order.findUnique.mockResolvedValue(null);
    shopeeAuth.ensureFreshConnection.mockResolvedValue(conn);
  });

  it('kéo đơn Shopee và tạo order với mã order_sn', async () => {
    const result = await service.syncShopeeOrders(user as never);

    expect(result.synced).toBe(1);
    expect(client.getOrderList).toHaveBeenCalled();
    expect(orders.createFromResolvedItems).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '240101ABC',
        sourceName: 'shopee',
        locationId,
      }),
      user,
    );
    expect(result.results[0]).toMatchObject({
      order_sn: '240101ABC',
      order_id: '100',
    });
  });

  it('bỏ qua đơn đã tồn tại theo name', async () => {
    prisma.order.findUnique.mockResolvedValue({
      id: BigInt(200),
      name: '240101ABC',
    });

    const result = await service.syncShopeeOrders(user as never);

    expect(result.skipped).toBe(1);
    expect(orders.createFromResolvedItems).not.toHaveBeenCalled();
  });
});
