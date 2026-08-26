/**
 * Unit test kiểm hàng — Prisma và InventoryService đều là bản giả, KHÔNG chạm DB.
 *
 * Bổ sung cho `stocktake-flow.e2e-spec.ts` (chạy trên Postgres thật, mặc định skip): file
 * này chạy trong mọi lượt `npm test`, giữ bốn quy tắc dễ vỡ nhất của luồng:
 * dòng chưa đếm ≠ đếm ra 0, phiếu đã cân bằng thì đóng băng, lệch tính trên tồn ĐỌC LẠI lúc
 * cân bằng, và lỗi hết tồn phải nêu đúng SKU thay vì ném nguyên "Không đủ tồn available".
 */
import { StocktakeStatus } from '@prisma/client';
import { StocktakeService } from '../src/modules/stocktakes/stocktake.service';
import { InsufficientStockException } from '../src/common/exceptions/business.exception';
import type { InventoryService } from '../src/modules/inventory/inventory.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { adminAuth } from './helpers/auth';

const USER = adminAuth({ userId: 7n, locationIds: [1n] });

type ItemRow = {
  id: bigint;
  variantId: bigint;
  systemQuantity: number;
  countedQuantity: number | null;
  note: string | null;
  variant?: { sku: string };
};

/**
 * Prisma giả tối thiểu: đủ cho các nhánh service đi qua. `$transaction` gọi thẳng callback
 * với chính object này — logic đang test không phụ thuộc tính nguyên tử, phần đó đã có
 * e2e chạy trên Postgres thật lo.
 */
function makePrisma(opts: {
  stocktake?: {
    id: bigint;
    locationId: bigint;
    status: StocktakeStatus;
    code: string;
    items?: ItemRow[];
  } | null;
  levels?: Record<string, number>;
}) {
  const created: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const client: Record<string, any> = {
    location: {
      findUniqueOrThrow: jest.fn(async () => ({ id: 1n })),
    },
    inventoryLevel: {
      findMany: jest.fn(async () =>
        Object.entries(opts.levels ?? {}).map(([variantId, onHand]) => ({
          variantId: BigInt(variantId),
          onHand,
        })),
      ),
      findUnique: jest.fn(
        async ({
          where,
        }: {
          where: { variantId_locationId: { variantId: bigint } };
        }) => ({
          onHand:
            opts.levels?.[String(where.variantId_locationId.variantId)] ?? 0,
        }),
      ),
    },
    stocktake: {
      count: jest.fn(async () => 0),
      findUnique: jest.fn(async () => opts.stocktake ?? null),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        // `items` phải đứng SAU spread: `data.items` là dạng nested-create của Prisma
        // ({ create: [...] }), để nó lọt ra ngoài thì serializer gọi .map() sẽ nổ.
        return {
          ...data,
          id: 1n,
          code: data.code,
          items: [],
          diffLineCount: 0,
          diffQuantity: 0,
          createdAt: new Date(),
          balancedAt: null,
          cancelledAt: null,
        };
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updated.push(data);
        return {
          id: 1n,
          code: 'KK000001',
          locationId: 1n,
          status: StocktakeStatus.checking,
          items: [],
          diffLineCount: 0,
          diffQuantity: 0,
          createdAt: new Date(),
          balancedAt: null,
          cancelledAt: null,
          note: null,
          ...data,
        };
      }),
    },
    stocktakeItem: {
      deleteMany: jest.fn(async () => ({ count: 0 })),
      upsert: jest.fn(async () => ({})),
    },
    activityLog: { create: jest.fn(async () => ({})) },
  };
  // Gán sau khi `client` đã dựng xong: gán ngay trong object literal thì TS không suy được
  // kiểu vì hàm tham chiếu chính object đang khai báo.
  client.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) =>
    fn(client),
  );
  return {
    prisma: client as unknown as PrismaService,
    created,
    updated,
    client,
  };
}

type AdjustArgs = {
  variantId: bigint;
  locationId: bigint;
  targetOnHand: number;
  referenceType?: string;
  referenceId?: bigint;
  createdById?: bigint;
};
const noopAdjust = () => jest.fn(async (_i: AdjustArgs) => null);

const makeInventory = (adjust = noopAdjust()) =>
  ({ adjustOnHandTo: adjust }) as unknown as InventoryService;

describe('StocktakeService', () => {
  describe('tạo phiếu', () => {
    it('chụp tồn hệ thống và gộp dòng trùng phiên bản', async () => {
      const { prisma, created } = makePrisma({ levels: { '5': 42 } });
      const service = new StocktakeService(prisma, makeInventory());

      await service.create(
        {
          location_id: '1',
          items: [
            { variant_id: '5', counted_quantity: 1 },
            // Cùng phiên bản — bảng có UNIQUE(phiếu, phiên bản), dòng sau phải thắng
            { variant_id: '5', counted_quantity: 9 },
          ],
        },
        USER,
      );

      const items = (created[0].items as { create: ItemRow[] }).create;
      expect(items).toHaveLength(1);
      expect(items[0].systemQuantity).toBe(42);
      expect(items[0].countedQuantity).toBe(9);
    });

    it('bỏ trống số đếm = CHƯA đếm, không phải đếm ra 0', async () => {
      const { prisma, created } = makePrisma({ levels: { '5': 42 } });
      const service = new StocktakeService(prisma, makeInventory());

      await service.create(
        { location_id: '1', items: [{ variant_id: '5' }] },
        USER,
      );

      const items = (created[0].items as { create: ItemRow[] }).create;
      expect(items[0].countedQuantity).toBeNull();
    });

    it('phiếu rỗng bị chặn', async () => {
      const { prisma } = makePrisma({});
      const service = new StocktakeService(prisma, makeInventory());

      await expect(
        service.create({ location_id: '1', items: [] }, USER),
      ).rejects.toMatchObject({ code: 'STOCKTAKE_EMPTY' });
    });
  });

  describe('cân bằng', () => {
    const phieu = (
      items: ItemRow[],
      status: StocktakeStatus = StocktakeStatus.checking,
    ) => ({
      id: 1n,
      locationId: 1n,
      code: 'KK000001',
      status,
      items,
    });

    it('kéo tồn về đúng số đếm và chốt lệch theo tồn đọc lại', async () => {
      const adjust = noopAdjust();
      const { prisma, updated } = makePrisma({
        stocktake: phieu([
          {
            id: 1n,
            variantId: 5n,
            systemQuantity: 100,
            countedQuantity: 93,
            note: null,
            variant: { sku: 'SKU-A' },
          },
        ]),
        // Tồn đã tụt còn 95 kể từ lúc lập phiếu ⇒ lệch chốt phải là 93 − 95 = −2,
        // KHÔNG phải 93 − 100 = −7 theo ảnh chụp cũ.
        levels: { '5': 95 },
      });
      const service = new StocktakeService(prisma, makeInventory(adjust));

      await service.balance(1n, USER);

      expect(adjust).toHaveBeenCalledTimes(1);
      expect(adjust.mock.calls[0][0]).toMatchObject({
        variantId: 5n,
        targetOnHand: 93,
        referenceType: 'stocktake',
        referenceId: 1n,
      });
      expect(updated[0]).toMatchObject({
        status: StocktakeStatus.balanced,
        diffLineCount: 1,
        diffQuantity: -2,
      });
    });

    it('bỏ qua dòng chưa đếm, không hiểu là 0', async () => {
      const adjust = noopAdjust();
      const { prisma } = makePrisma({
        stocktake: phieu([
          {
            id: 1n,
            variantId: 5n,
            systemQuantity: 10,
            countedQuantity: null,
            note: null,
          },
        ]),
      });
      const service = new StocktakeService(prisma, makeInventory(adjust));

      await expect(service.balance(1n, USER)).rejects.toMatchObject({
        code: 'STOCKTAKE_NOTHING_COUNTED',
      });
      expect(adjust).not.toHaveBeenCalled();
    });

    it('đếm thấp hơn phần đang giữ chỗ thì báo rõ SKU', async () => {
      const adjust = jest.fn(async (_i: AdjustArgs) => {
        throw new InsufficientStockException();
      });
      const { prisma } = makePrisma({
        stocktake: phieu([
          {
            id: 1n,
            variantId: 5n,
            systemQuantity: 10,
            countedQuantity: 1,
            note: null,
            variant: { sku: 'SKU-KET' },
          },
        ]),
        levels: { '5': 10 },
      });
      const service = new StocktakeService(prisma, makeInventory(adjust));

      await expect(service.balance(1n, USER)).rejects.toMatchObject({
        code: 'STOCKTAKE_BLOCKED_BY_COMMITTED',
        message: expect.stringContaining('SKU-KET'),
      });
    });

    it('phiếu đã cân bằng thì không cân bằng lại', async () => {
      const { prisma } = makePrisma({
        stocktake: phieu([], StocktakeStatus.balanced),
      });
      const service = new StocktakeService(prisma, makeInventory());

      await expect(service.balance(1n, USER)).rejects.toMatchObject({
        code: 'STOCKTAKE_ALREADY_BALANCED',
      });
    });
  });

  describe('khoá phiếu đã chốt', () => {
    it('không sửa được phiếu đã cân bằng', async () => {
      const { prisma } = makePrisma({
        stocktake: {
          id: 1n,
          locationId: 1n,
          code: 'KK000001',
          status: StocktakeStatus.balanced,
        },
      });
      const service = new StocktakeService(prisma, makeInventory());

      await expect(
        service.update(1n, { note: 'sửa' }, USER),
      ).rejects.toMatchObject({ code: 'STOCKTAKE_ALREADY_BALANCED' });
    });

    it('không huỷ được phiếu đã huỷ', async () => {
      const { prisma } = makePrisma({
        stocktake: {
          id: 1n,
          locationId: 1n,
          code: 'KK000001',
          status: StocktakeStatus.cancelled,
        },
      });
      const service = new StocktakeService(prisma, makeInventory());

      await expect(service.cancel(1n, USER)).rejects.toMatchObject({
        code: 'STOCKTAKE_CANCELLED',
      });
    });
  });
});
