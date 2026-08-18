/**
 * E2E cho xác thực API key qua header `x-api-key` (đối tác bên thứ 3, không qua phiên).
 * Key xác thực THAY một user có sẵn (`ApiKey.actingUserId`) nên hoạt động trên MỌI route
 * — quyền của key = quyền thật của user đó, kiểm bởi đúng `PermissionGuard` dùng cho phiên người dùng.
 *
 * Bootstrap AppModule thật qua supertest (không gọi thẳng service) vì cần test đúng chuỗi
 * guard toàn cục (JwtAuthGuard nhận diện x-api-key trước khi rơi về giải mã phiên, rồi
 * PermissionGuard/ThrottlerGuard chạy tiếp bình thường).
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

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

const REPORT_ROUTE = '/api/reports/product-monthly-ops';
const PRODUCTS_ROUTE = '/api/products';
const API_KEYS_ROUTE = '/api/api-keys';

describeIfDb('API key auth (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let apiKeys: ApiKeyService;
  let adminUserId: bigint;
  let salesUserId: bigint;
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

    const admin = await prisma.user.findFirst({
      where: { email: 'admin@local.dev' },
    });
    const sales = await prisma.user.findFirst({
      where: { email: 'sales@local.dev' },
    });
    if (!admin || !sales) {
      throw new Error('Run prisma db seed before integration tests');
    }
    adminUserId = admin.id;
    salesUserId = sales.id;

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
    actingUserId: bigint,
    overrides: { expiresAt?: string } = {},
  ) {
    const callingAdmin: AuthUser = {
      userId: adminUserId,
      email: 'admin@local.dev',
      roles: [],
      locationIds: [],
      isAdmin: true,
    };
    const result = await apiKeys.create(
      {
        name: `e2e-test-${Date.now()}`,
        acting_user_id: actingUserId.toString(),
        expires_at: overrides.expiresAt,
      },
      callingAdmin,
    );
    createdKeyIds.push(BigInt(result.id));
    return result;
  }

  it('thiếu header x-api-key và JWT → 401', async () => {
    await request(app.getHttpServer()).get(REPORT_ROUTE).expect(401);
  });

  it('key sai/không tồn tại → 401', async () => {
    await request(app.getHttpServer())
      .get(REPORT_ROUTE)
      .set('x-api-key', 'whk_live_khong-ton-tai')
      .expect(401);
  });

  it('key acting as admin → gọi được route báo cáo', async () => {
    const { api_key } = await createKey(adminUserId);
    const res = await request(app.getHttpServer())
      .get(REPORT_ROUTE)
      .query({ month: '2026-07' })
      .set('x-api-key', api_key)
      .expect(200);

    expect(res.body.period).toEqual({
      year: 2026,
      month: 7,
      from: '2026-06-30',
      to: '2026-07-31',
    });
  }, 15_000);

  it('CÙNG key acting as admin → gọi được route khác hẳn (sản phẩm) — chứng minh không bị khoá vào 1 API', async () => {
    const { api_key } = await createKey(adminUserId);
    const res = await request(app.getHttpServer())
      .get(PRODUCTS_ROUTE)
      .set('x-api-key', api_key)
      .expect(200);
    expect(res.body).toBeDefined();
  });

  it('key acting as user quyền hẹp (sales) → 403 với endpoint chỉ admin mới có quyền', async () => {
    const { api_key } = await createKey(salesUserId);
    // sales không có quyền api_key:manage — chứng minh quyền của key = quyền THẬT của
    // acting user, không phải luôn full quyền bất kể acting user là ai.
    await request(app.getHttpServer())
      .get(API_KEYS_ROUTE)
      .set('x-api-key', api_key)
      .expect(403);
  });

  it('key đã bị revoke → 401', async () => {
    const { id, api_key } = await createKey(adminUserId);
    await apiKeys.revoke(id);
    await request(app.getHttpServer())
      .get(REPORT_ROUTE)
      .set('x-api-key', api_key)
      .expect(401);
  });

  it('key đã hết hạn → 401', async () => {
    const { api_key } = await createKey(adminUserId, {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await request(app.getHttpServer())
      .get(REPORT_ROUTE)
      .set('x-api-key', api_key)
      .expect(401);
  });

  it('vượt rate limit (120/phút cho traffic x-api-key) → 429', async () => {
    // Bắn vào /api/health (route @Public, gần như tức thời) thay vì route báo cáo — chỉ
    // cần header x-api-key CÓ MẶT để rơi vào nhánh throttle (ThrottlerGuard.skipIf chỉ xét
    // sự hiện diện của header, không xét key có hợp lệ hay không). Cách này đo đúng cơ chế
    // throttle mà không phụ thuộc tốc độ của một endpoint nặng/độ trễ DB thật.
    //
    // Gọi TUẦN TỰ (không Promise.all) — bắn ~20 request đồng thời vào server test ephemeral
    // gây ECONNRESET; /api/health đủ nhanh để tuần tự vẫn xong trong vài giây.
    const MAX_REQUESTS = 130;
    let got429 = false;
    for (let i = 0; i < MAX_REQUESTS && !got429; i++) {
      const res = await request(app.getHttpServer())
        .get('/api/health')
        .set('x-api-key', 'khong-can-hop-le-de-test-throttle');
      got429 = res.status === 429;
    }
    expect(got429).toBe(true);
  }, 20_000);

  it('traffic JWT thường không bị đếm vào rate limit của x-api-key (skipIf)', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'admin@local.dev', password: 'password123' })
      .expect(201);
    const token = login.body.access_token as string;

    await request(app.getHttpServer())
      .get(REPORT_ROUTE)
      .query({ month: '2026-07', location_id: cheapLocationId })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  }, 20_000);
});
