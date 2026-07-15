import { PrismaService } from '../src/prisma/prisma.service';
import { ProductRepository } from '../src/modules/products/product.repository';

describe('ProductRepository.variantIdsWithInventory', () => {
  it('trả Set variantId có tồn kho > 0', async () => {
    const db = {
      inventoryLevel: {
        groupBy: jest.fn().mockResolvedValue([
          {
            variantId: 10n,
            _sum: { onHand: 2, committed: 0, incoming: 0 },
          },
          {
            variantId: 20n,
            _sum: { onHand: 0, committed: 0, incoming: 0 },
          },
        ]),
      },
    } as unknown as PrismaService;

    const repo = new ProductRepository(db);
    const inUse = await repo.variantIdsWithInventory(db, [10n, 20n, 30n]);

    expect(inUse).toEqual(new Set([10n]));
    expect(db.inventoryLevel.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { variantId: { in: [10n, 20n, 30n] } },
      }),
    );
  });

  it('trả Set rỗng khi không có variantId', async () => {
    const db = {
      inventoryLevel: { groupBy: jest.fn() },
    } as unknown as PrismaService;
    const repo = new ProductRepository(db);

    await expect(repo.variantIdsWithInventory(db, [])).resolves.toEqual(new Set());
    expect(db.inventoryLevel.groupBy).not.toHaveBeenCalled();
  });
});
