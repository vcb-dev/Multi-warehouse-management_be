/**
 * E2E cho xác thực API key (đối tác bên thứ 3, không qua JWT) trên
 * GET /api/integrations/reports/san-pham-van-hanh-theo-thang.
 *
 * Bootstrap AppModule thật qua supertest (không gọi thẳng service như các *.e2e-spec.ts khác)
 * vì cần test đúng chuỗi guard (JwtAuthGuard bỏ qua do @Public, PermissionGuard no-op vì
 * route không khai @RequirePermission, ApiKeyGuard tự xác thực, ThrottlerGuard rate-limit).
 *
 * Chạy: RUN_INTEGRATION_TESTS=1 npm test -- test/api-key-integration.e2e-spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ApiKeyService } from '../src/modules/api-keys/api-key.service';
import type { AuthUser } from '../src/common/decorators/current-user.decorator';

const admin: AuthUser = {
  userId: 0n,
  email: 'system-test@local.dev',
  roles: [],
  locationIds: [],
  isAdmin: true,
};

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

const ROUTE = '/api/integrations/reports/san-pham-van-hanh-theo-thang';

describeIfDb('API key auth (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let apiKeys: ApiKeyService;
  let adminUserId: bigint;
  let cheapLocationId: string;
  const createdKeyIds: bigint[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();

    prisma = moduleFixture.get(PrismaService);
    apiKeys = moduleFixture.get(ApiKeyService);

    const user = await prisma.user.findFirst({
      where: { email: 'admin@local.dev' },
    });
    if (!user) throw new Error('Run prisma db seed before integration tests');
    adminUserId = user.id;

    // Giới hạn theo 1 kho cho test rate-limit — bản admin (mọi kho) quá nặng để bắn
    // hàng chục request liên tiếp vào DB thật.
    const location = await prisma.location.findFirst({ select: { id: true } });
    if (!location) throw new Error('DB không có location nào để test');
    cheapLocationId = location.id.toString();
  });

  afterAll(async () => {
    if (createdKeyIds.length) {
      await prisma.apiKey.deleteMany({ where: { id: { in: createdKeyIds } } });
    }
    await app.close();
  });

  async function createKey(
    overrides: {
      scopes?: string[];
      expiresAt?: string;
    } = {},
  ) {
    const result = await apiKeys.create(
      {
        name: `e2e-test-${Date.now()}`,
        scopes: overrides.scopes ?? ['product-monthly-ops'],
        expires_at: overrides.expiresAt,
      },
      { ...admin, userId: adminUserId },
    );
    createdKeyIds.push(BigInt(result.id));
    return result;
  }

  it('thiếu header x-api-key → 401', async () => {
    await request(app.getHttpServer()).get(ROUTE).expect(401);
  });

  it('key sai/không tồn tại → 401', async () => {
    await request(app.getHttpServer())
      .get(ROUTE)
      .set('x-api-key', 'whk_live_khong-ton-tai')
      .expect(401);
  });

  it('key hợp lệ, đúng scope → 200, trả đúng field như route JWT', async () => {
    const { api_key } = await createKey();
    const res = await request(app.getHttpServer())
      .get(ROUTE)
      .query({ month: '2026-07' })
      .set('x-api-key', api_key)
      .expect(200);

    expect(res.body.period).toEqual({
      year: 2026,
      month: 7,
      from: '2026-06-30',
      to: '2026-07-31',
    });
    expect(typeof res.body.kpis.products_ordered.value).toBe('number');
    expect(Array.isArray(res.body.top_ordered_products)).toBe(true);
  }, 15_000);

  it('key đúng nhưng sai scope → 403', async () => {
    const { api_key } = await createKey({ scopes: ['other-report'] });
    await request(app.getHttpServer())
      .get(ROUTE)
      .set('x-api-key', api_key)
      .expect(403);
  });

  it('key đã bị revoke → 401', async () => {
    const { id, api_key } = await createKey();
    await apiKeys.revoke(id);
    await request(app.getHttpServer())
      .get(ROUTE)
      .set('x-api-key', api_key)
      .expect(401);
  });

  it('key đã hết hạn → 401', async () => {
    const { api_key } = await createKey({
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await request(app.getHttpServer())
      .get(ROUTE)
      .set('x-api-key', api_key)
      .expect(401);
  });

  it('vượt rate limit (60/phút) → 429', async () => {
    const { api_key } = await createKey();
    // Bắn theo lô nhỏ (không phải 61 request đồng thời) để không làm cạn connection pool
    // của Prisma khi các request được throttler chấp nhận đều thật sự chạm DB. Dừng ngay
    // khi thấy 429 đầu tiên thay vì luôn gọi đủ 65 lần.
    const BATCH_SIZE = 8;
    const MAX_REQUESTS = 65;
    let got429 = false;
    for (let sent = 0; sent < MAX_REQUESTS && !got429; sent += BATCH_SIZE) {
      const batch = Array.from(
        { length: Math.min(BATCH_SIZE, MAX_REQUESTS - sent) },
        () =>
          request(app.getHttpServer())
            .get(ROUTE)
            .query({ month: '2026-07', location_id: cheapLocationId })
            .set('x-api-key', api_key),
      );
      const results = await Promise.all(batch);
      got429 = results.some((r) => r.status === 429);
    }
    expect(got429).toBe(true);
  }, 30_000);
});
