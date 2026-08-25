/**
 * Đồng bộ kho từ Sapo: thêm mới, cập nhật, không-đổi, né trùng `code`, báo kho vắng mặt.
 * Chạy: RUN_INTEGRATION_TESTS=1 npm run test:e2e -- sapo-location-sync
 *
 * `SapoClient` bị thay bằng bản giả nên test KHÔNG gọi mạng. Bản giả chỉ trả về kho có
 * `sapo_id` trong dải 999900xx: kho thật trong DB không nằm trong danh sách trả về nên chỉ
 * bị *báo cáo* là vắng mặt, không bị ghi gì — an toàn cả khi ai đó lỡ trỏ vào DB thật.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { SapoLocationSyncService } from '../src/modules/channels/sapo/sapo-location-sync.service';
import { SapoClient } from '../src/modules/products/sapo-sync/sapo-client';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

const SAPO_A = 99990001;
const SAPO_B = 99990002;
const CODE = `E2E-LOC-${Date.now() % 100000}`;

type FakeLocation = Record<string, unknown>;

class FakeSapoClient {
  locations: FakeLocation[] = [];
  isConfigured() {
    return true;
  }
  get<T>(path: string): Promise<T> {
    // Trang 2 trả rỗng để vòng phân trang của service dừng lại.
    const page = Number(new URL(`http://x${path}`).searchParams.get('page'));
    return Promise.resolve({
      locations: page === 1 ? this.locations : [],
    } as T);
  }
}

describeIfDb('đồng bộ kho từ Sapo', () => {
  let service: SapoLocationSyncService;
  let sapo: FakeSapoClient;
  let prisma: PrismaService;

  beforeAll(async () => {
    sapo = new FakeSapoClient();
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [SapoLocationSyncService, SapoClient],
    })
      .overrideProvider(SapoClient)
      .useValue(sapo)
      .compile();
    service = module.get(SapoLocationSyncService);
    prisma = module.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.location.deleteMany({
      where: { sapoId: { in: [BigInt(SAPO_A), BigInt(SAPO_B)] } },
    });
    await prisma.$disconnect();
  });

  it('thêm kho mới và báo đúng danh sách kho mới', async () => {
    sapo.locations = [
      { id: SAPO_A, name: 'Kho E2E A', code: CODE, status: 'active' },
    ];
    const r = await service.syncLocations();

    expect(r.created).toBe(1);
    expect(r.new_locations).toEqual([
      { sapo_id: String(SAPO_A), name: 'Kho E2E A' },
    ]);
    const row = await prisma.location.findUniqueOrThrow({
      where: { sapoId: BigInt(SAPO_A) },
    });
    expect(row.name).toBe('Kho E2E A');
    expect(row.code).toBe(CODE);
  });

  it('kho thật trong DB không bị đụng, chỉ báo là Sapo không trả về', async () => {
    const r = await service.syncLocations();
    expect(r.missing_in_sapo.length).toBeGreaterThan(0);
    expect(
      r.missing_in_sapo.some((l) => l.sapo_id === String(SAPO_A)),
    ).toBe(false);
  });

  it('lượt chạy lại không đổi gì thì đếm vào unchanged', async () => {
    const before = await prisma.location.findUniqueOrThrow({
      where: { sapoId: BigInt(SAPO_A) },
    });
    const r = await service.syncLocations();

    expect(r.unchanged).toBe(1);
    expect(r.updated).toBe(0);
    const after = await prisma.location.findUniqueOrThrow({
      where: { sapoId: BigInt(SAPO_A) },
    });
    // `modified_on` là @updatedAt — lượt chạy vô nghĩa mà vẫn ghi thì cột này sẽ nhảy
    expect(after.modifiedOn.toISOString()).toBe(before.modifiedOn.toISOString());
  });

  it('đổi tên/trạng thái bên Sapo thì cập nhật về', async () => {
    sapo.locations = [
      { id: SAPO_A, name: 'Kho E2E A (đổi tên)', code: CODE, status: 'inactive' },
    ];
    const r = await service.syncLocations();

    expect(r.updated).toBe(1);
    const row = await prisma.location.findUniqueOrThrow({
      where: { sapoId: BigInt(SAPO_A) },
    });
    expect(row.name).toBe('Kho E2E A (đổi tên)');
    expect(row.status).toBe('inactive');
  });

  it('code trùng kho khác thì bỏ riêng trường code, vẫn tạo kho', async () => {
    sapo.locations = [
      { id: SAPO_A, name: 'Kho E2E A (đổi tên)', code: CODE, status: 'inactive' },
      // Cùng `code` với kho A — nếu ghi thẳng sẽ vỡ UNIQUE và chết cả lượt đồng bộ
      { id: SAPO_B, name: 'Kho E2E B', code: CODE, status: 'active' },
    ];
    const r = await service.syncLocations();

    expect(r.code_conflicts).toContain(CODE);
    const b = await prisma.location.findUniqueOrThrow({
      where: { sapoId: BigInt(SAPO_B) },
    });
    expect(b.name).toBe('Kho E2E B');
    expect(b.code).toBeNull();
  });
});
