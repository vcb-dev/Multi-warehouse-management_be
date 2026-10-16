import { OrderSource } from '@prisma/client';
import {
  currentSellerStock,
  ShopeeInventorySyncService,
  toSellerStock,
} from '../src/modules/channels/shopee/shopee-inventory-sync.service';

describe('ShopeeInventorySyncService', () => {
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
    },
    productVariant: {
      findMany: jest.fn().mockResolvedValue([
        { id: BigInt(99), sku: 'SKU-1' },
        { id: BigInt(100), sku: 'SKU-2' },
      ]),
    },
    inventoryLevel: {
      findMany: jest.fn().mockResolvedValue([
        { variantId: BigInt(99), available: 7 },
        { variantId: BigInt(100), available: 3 },
      ]),
    },
    location: { findFirst: jest.fn() },
  };

  const client = {
    getItemList: jest.fn(),
    getItemBaseInfo: jest.fn(),
    getModelList: jest.fn(),
    updateStock: jest.fn(),
  };

  const shopeeAuth = {
    getClient: jest.fn().mockReturnValue(client),
    ensureFreshConnection: jest.fn().mockResolvedValue(conn),
  };

  const service = new ShopeeInventorySyncService(
    prisma as never,
    shopeeAuth as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.channelConnection.findMany.mockResolvedValue([conn]);
    prisma.inventoryLevel.findMany.mockResolvedValue([
      { variantId: BigInt(99), available: 7 },
      { variantId: BigInt(100), available: 3 },
    ]);
    shopeeAuth.getClient.mockReturnValue(client);
    shopeeAuth.ensureFreshConnection.mockResolvedValue(conn);
    client.getItemList.mockResolvedValue({
      item: [{ item_id: 11, item_status: 'NORMAL' }],
      has_next_page: false,
      next_offset: 0,
    });
    client.getItemBaseInfo.mockResolvedValue({
      item_list: [{ item_id: 11, item_sku: '', has_model: true }],
    });
    client.getModelList.mockResolvedValue({
      model: [
        {
          model_id: 21,
          model_sku: 'SKU-1',
          model_status: 'MODEL_NORMAL',
          stock_info_v2: { seller_stock: [{ stock: 1 }] },
        },
        {
          model_id: 22,
          model_sku: 'NO-OMS',
          model_status: 'MODEL_NORMAL',
          stock_info_v2: { seller_stock: [{ stock: 9 }] },
        },
      ],
    });
    client.updateStock.mockResolvedValue({ success_list: [{ model_id: 21 }] });
  });

  it('đẩy available kho gắn shop, không cộng kho khác, bỏ SKU không có trên OMS', async () => {
    const [actual] = await service.syncInventory();

    expect(actual.updated).toBe(1);
    expect(actual.unmatched).toBe(1);
    expect(actual.unmatched_skus).toEqual(['NO-OMS']);
    expect(client.updateStock).toHaveBeenCalledWith(
      'access',
      '227834954',
      11,
      [{ model_id: 21, seller_stock: [{ stock: 7 }] }],
    );
    expect(prisma.inventoryLevel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ locationId }),
      }),
    );
  });

  it('dry-run không gọi update_stock', async () => {
    const [actual] = await service.syncInventory(undefined, { dryRun: true });

    expect(actual.dry_run).toBe(true);
    expect(actual.updated).toBe(1);
    expect(client.updateStock).not.toHaveBeenCalled();
    expect(actual.changes[0]).toMatchObject({
      sku: 'SKU-1',
      oms_available: 7,
      shopee_stock: 1,
      action: 'update',
    });
  });

  it('available âm đẩy 0; đã khớp thì bỏ qua', async () => {
    prisma.inventoryLevel.findMany.mockResolvedValue([
      { variantId: BigInt(99), available: -4 },
    ]);
    client.getModelList.mockResolvedValue({
      model: [
        {
          model_id: 21,
          model_sku: 'SKU-1',
          model_status: 'MODEL_NORMAL',
          stock_info_v2: { seller_stock: [{ stock: 0 }] },
        },
      ],
    });

    const [actual] = await service.syncInventory();

    expect(actual.updated).toBe(0);
    expect(actual.skipped_same).toBe(1);
    expect(client.updateStock).not.toHaveBeenCalled();
  });

  it('item không biến thể khớp item_sku, model_id = 0', async () => {
    client.getItemBaseInfo.mockResolvedValue({
      item_list: [
        {
          item_id: 11,
          item_sku: 'SKU-1',
          has_model: false,
          stock_info_v2: { seller_stock: [{ stock: 2 }] },
        },
      ],
    });

    await service.syncInventory();

    expect(client.getModelList).not.toHaveBeenCalled();
    expect(client.updateStock).toHaveBeenCalledWith(
      'access',
      '227834954',
      11,
      [{ model_id: 0, seller_stock: [{ stock: 7 }] }],
    );
  });
});

describe('toSellerStock', () => {
  it('không gửi location_id khi shop 1 kho', () => {
    expect(toSellerStock([{ stock: 4 }], 8)).toEqual([{ stock: 8 }]);
    expect(currentSellerStock([{ stock: 4 }])).toBe(4);
  });

  it('shop nhiều kho Shopee: ghi kho đầu, giữ kho còn lại', () => {
    expect(
      toSellerStock(
        [
          { location_id: 'A', stock: 1 },
          { location_id: 'B', stock: 9 },
        ],
        5,
      ),
    ).toEqual([
      { location_id: 'A', stock: 5 },
      { location_id: 'B', stock: 9 },
    ]);
  });
});
