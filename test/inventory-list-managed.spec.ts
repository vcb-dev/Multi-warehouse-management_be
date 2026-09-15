/**
 * Danh sách tồn kho theo kho: `managed_only` (màn Tồn kho) và mặc định (ô chọn sản phẩm).
 * Chạy: npm test -- test/inventory-list-managed.spec.ts
 *
 * Toàn bộ mock, KHÔNG chạm DB.
 */
import { InventoryQueryService } from '../src/modules/inventory/inventory-query.service';
import type { InventoryNxtService } from '../src/modules/inventory/inventory-nxt.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { adminAuth, staffAuth } from './helpers/auth';

function makeService() {
  const prisma = {
    inventoryLevel: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    productVariant: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    location: {
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ id: 5n, code: null, name: 'Kho 5' }),
    },
  };
  const nxt = { enrich: jest.fn().mockResolvedValue(new Map()) };
  const service = new InventoryQueryService(
    prisma as unknown as PrismaService,
    nxt as unknown as InventoryNxtService,
  );
  return { service, prisma };
}

describe('InventoryQueryService.listInventory — managed_only', () => {
  it('chọn kho + managed_only: chỉ đọc dòng inventory_levels của đúng kho đó', async () => {
    const { service, prisma } = makeService();

    await service.listInventory(
      { location_id: '5', managed_only: true },
      adminAuth(),
    );

    expect(prisma.productVariant.findMany).not.toHaveBeenCalled();
    expect(prisma.inventoryLevel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ locationId: 5n }),
      }),
    );
    expect(prisma.inventoryLevel.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ locationId: 5n }),
    });
  });

  it('chọn kho, không managed_only: vẫn liệt kê cả catalog cho ô chọn sản phẩm', async () => {
    const { service, prisma } = makeService();

    await service.listInventory({ location_id: '5' }, adminAuth());

    expect(prisma.productVariant.findMany).toHaveBeenCalled();
    expect(prisma.inventoryLevel.findMany).not.toHaveBeenCalled();
  });

  it('managed_only không cho xem kho ngoài quyền', async () => {
    const { service, prisma } = makeService();
    const staff = staffAuth({
      locationIds: [7n],
      warehousePermissions: { '7': ['inventory:view'] },
    });

    await expect(
      service.listInventory({ location_id: '5', managed_only: true }, staff),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_SCOPE', statusCode: 403 });
    expect(prisma.inventoryLevel.findMany).not.toHaveBeenCalled();
  });

  it('xuất file theo kho + managed_only đi cùng nhánh với màn hình', async () => {
    const { service, prisma } = makeService();

    await service.exportRows(
      { location_id: '5', managed_only: true },
      adminAuth(),
    );

    expect(prisma.productVariant.findMany).not.toHaveBeenCalled();
    expect(prisma.inventoryLevel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ locationId: 5n }),
      }),
    );
  });
});
