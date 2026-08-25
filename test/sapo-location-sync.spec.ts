/**
 * Unit test đồng bộ kho Sapo — Prisma và SapoClient đều là bản giả, KHÔNG chạm DB/mạng.
 *
 * Bổ sung cho `sapo-location-sync.e2e-spec.ts` (chạy trên Postgres thật, mặc định skip):
 * file này chạy trong mọi lượt `npm test` nên là lưới an toàn thường trực cho ba quyết định
 * dễ vỡ nhất: không ghi khi không có gì đổi, không bao giờ xoá kho, và né trùng `code`.
 */
import { SapoLocationSyncService } from '../src/modules/channels/sapo/sapo-location-sync.service';
import type { SapoClient } from '../src/modules/products/sapo-sync/sapo-client';
import type { PrismaService } from '../src/prisma/prisma.service';

type LocRow = {
  id: bigint;
  sapoId: bigint | null;
  code: string | null;
  name: string;
  status: string;
};

function makePrisma(rows: LocRow[]) {
  const store = [...rows];
  const create = jest.fn(
    async ({ data }: { data: Record<string, unknown> }) => {
      const row = {
        id: BigInt(store.length + 100),
        sapoId: data.sapoId as bigint,
        code: (data.code as string) ?? null,
        name: data.name as string,
        status: (data.status as string) ?? 'active',
      };
      store.push(row);
      return row;
    },
  );
  const update = jest.fn(
    async (_args: { where: { id: bigint }; data: Record<string, unknown> }) =>
      ({}) as unknown,
  );
  const prisma = {
    location: {
      findMany: jest.fn(async () => store),
      // Bản ghi "đầy đủ" để so sánh trước khi ghi — chỉ cần các cột service đụng tới.
      findUniqueOrThrow: jest.fn(
        async ({ where }: { where: { id: bigint } }) => {
          const row = store.find((r) => r.id === where.id);
          return {
            ...row,
            storeId: null,
            email: null,
            phone: null,
            address1: null,
            address2: null,
            city: null,
            province: null,
            provinceCode: null,
            district: null,
            districtCode: null,
            ward: null,
            wardCode: null,
            country: null,
            countryCode: null,
            zip: null,
            defaultLocation: false,
            fulfillOrder: false,
            fulfillmentPickup: false,
            inventoryManagement: true,
            deactivateInventoryAt: null,
            offlineStore: false,
            ownerType: null,
            inventoryProcessStatus: null,
          };
        },
      ),
      create,
      update,
    },
  } as unknown as PrismaService;
  return { prisma, create, update };
}

function makeSapo(locations: Record<string, unknown>[]) {
  return {
    isConfigured: () => true,
    // Trang 2 trả rỗng để vòng phân trang dừng.
    get: jest.fn(async (path: string) =>
      /page=1(&|$)/.test(path) ? { locations } : { locations: [] },
    ),
  } as unknown as SapoClient;
}

const baseRow: LocRow = {
  id: 1n,
  sapoId: 813198n,
  code: 'VCB01',
  name: 'Kho trung tâm (SSC)',
  status: 'active',
};

describe('SapoLocationSyncService', () => {
  it('thêm kho mới Sapo có mà DB chưa có', async () => {
    const { prisma, create } = makePrisma([baseRow]);
    const sapo = makeSapo([
      {
        id: 813198,
        name: 'Kho trung tâm (SSC)',
        code: 'VCB01',
        status: 'active',
      },
      { id: 999001, name: 'Kho mới toanh', status: 'active' },
    ]);
    const r = await new SapoLocationSyncService(prisma, sapo).syncLocations();

    expect(r.created).toBe(1);
    expect(r.new_locations).toEqual([
      { sapo_id: '999001', name: 'Kho mới toanh' },
    ]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('không đổi gì thì KHÔNG gọi update (giữ nguyên modified_on)', async () => {
    const { prisma, update } = makePrisma([baseRow]);
    const sapo = makeSapo([
      {
        id: 813198,
        name: 'Kho trung tâm (SSC)',
        code: 'VCB01',
        status: 'active',
      },
    ]);
    const r = await new SapoLocationSyncService(prisma, sapo).syncLocations();

    expect(r.unchanged).toBe(1);
    expect(r.updated).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });

  it('Sapo đổi tên/trạng thái thì cập nhật về', async () => {
    const { prisma, update } = makePrisma([baseRow]);
    const sapo = makeSapo([
      {
        id: 813198,
        name: 'Kho TT (đổi tên)',
        code: 'VCB01',
        status: 'inactive',
      },
    ]);
    const r = await new SapoLocationSyncService(prisma, sapo).syncLocations();

    expect(r.updated).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].data).toMatchObject({
      name: 'Kho TT (đổi tên)',
      status: 'inactive',
    });
  });

  it('kho DB có mà Sapo không trả thì CHỈ báo cáo, không đụng', async () => {
    const { prisma, update, create } = makePrisma([
      baseRow,
      {
        id: 2n,
        sapoId: 851502n,
        code: null,
        name: 'STORE Cũ',
        status: 'active',
      },
    ]);
    const sapo = makeSapo([
      {
        id: 813198,
        name: 'Kho trung tâm (SSC)',
        code: 'VCB01',
        status: 'active',
      },
    ]);
    const r = await new SapoLocationSyncService(prisma, sapo).syncLocations();

    expect(r.missing_in_sapo).toEqual([
      { sapo_id: '851502', name: 'STORE Cũ' },
    ]);
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('code trùng kho khác thì bỏ riêng trường code, vẫn tạo kho', async () => {
    const { prisma, create } = makePrisma([baseRow]);
    const sapo = makeSapo([
      {
        id: 813198,
        name: 'Kho trung tâm (SSC)',
        code: 'VCB01',
        status: 'active',
      },
      // Cùng code với kho đang có — ghi thẳng sẽ vỡ UNIQUE và chết cả lượt đồng bộ
      { id: 999002, name: 'Kho đụng mã', code: 'VCB01', status: 'active' },
    ]);
    const r = await new SapoLocationSyncService(prisma, sapo).syncLocations();

    expect(r.code_conflicts).toContain('VCB01');
    expect(r.created).toBe(1);
    expect(create.mock.calls[0][0].data.code).toBeUndefined();
    expect(create.mock.calls[0][0].data.name).toBe('Kho đụng mã');
  });

  it('kho không tên bên Sapo vẫn có nhãn nhận ra được', async () => {
    const { prisma, create } = makePrisma([]);
    const sapo = makeSapo([{ id: 999003, name: '   ', status: 'active' }]);
    await new SapoLocationSyncService(prisma, sapo).syncLocations();

    expect(create.mock.calls[0][0].data.name).toBe('Kho Sapo 999003');
  });

  it('thiếu cấu hình thì báo lỗi rõ, không gọi Sapo', async () => {
    const { prisma } = makePrisma([]);
    const sapo = {
      isConfigured: () => false,
      get: jest.fn(),
    } as unknown as SapoClient;

    await expect(
      new SapoLocationSyncService(prisma, sapo).syncLocations(),
    ).rejects.toMatchObject({ code: 'CHANNEL_NOT_CONFIGURED' });
    expect(sapo.get).not.toHaveBeenCalled();
  });
});
