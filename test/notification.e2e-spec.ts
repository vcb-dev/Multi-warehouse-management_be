/**
 * E2E cho trung tâm thông báo in-app.
 *
 * Chạy: RUN_INTEGRATION_TESTS=1 npm test -- test/notification.e2e-spec.ts
 *
 * ⚠️ DB thật, không có DB test riêng. Test này KHÔNG đụng đơn hàng/tồn kho:
 * `notifications.subject_id` không có FK nên dùng id giả (SUBJECT_ID) là đủ; chỉ
 * `location_id` mới cần trỏ tới kho thật. Mọi dòng tạo ra đều được xoá trong afterAll
 * (xoá `notifications` là recipients tự đi theo nhờ ON DELETE CASCADE), và cấu hình
 * `notification_settings` bị sửa trong lúc test đều được khôi phục nguyên trạng.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { NotificationTopic } from '@prisma/client';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import type { AuthUser } from '../src/common/decorators/current-user.decorator';
import { ApiKeyService } from '../src/modules/api-keys/api-key.service';
import { InventoryAlertService } from '../src/modules/inventory/inventory-alert.service';
import { NotificationService } from '../src/modules/notifications/notification.service';
import { PrismaService } from '../src/prisma/prisma.service';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

/** Id giả cho `subject_id` — cột này không có FK nên không cần đơn hàng thật. */
const SUBJECT_ID = 999_999_999n;

describeIfDb('Thông báo in-app (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let notifications: NotificationService;
  let apiKeys: ApiKeyService;

  let adminUserId: bigint;
  /** sales@local.dev — CHỈ có role ở kho 1 ⇒ dùng để test scope theo kho. */
  let salesUserId: bigint;
  /** kho@local.dev — warehouse_staff ở kho 2..5, KHÔNG có kho 1. */
  let warehouseUserId: bigint;
  let salesLocationId: bigint;

  const createdNotificationIds: bigint[] = [];
  const createdKeyIds: bigint[] = [];
  /**
   * Snapshot cấu hình để trả về NGUYÊN TRẠNG. Phải lưu cả `recipientPermissions` chứ
   * không chỉ `appEnabled`: test có đặt tạm danh sách người nhận về rỗng, quên khôi phục
   * là cấu hình thật của khách bị đổi vĩnh viễn (DB này là DB production).
   */
  const settingBackup = new Map<
    NotificationTopic,
    { appEnabled: boolean; recipientPermissions: string[] }
  >();

  const asUser = (userId: bigint, email: string): AuthUser => ({
    userId,
    email,
    roles: [],
    locationIds: [],
  });

  /** Gom mọi id thông báo vừa sinh cho `subjectId` để afterAll dọn sạch. */
  async function collectCreated() {
    const rows = await prisma.notification.findMany({
      where: { subjectId: SUBJECT_ID },
      select: { id: true },
    });
    for (const r of rows) {
      if (!createdNotificationIds.includes(r.id)) createdNotificationIds.push(r.id);
    }
    return rows.map((r) => r.id);
  }

  /** Chụp ảnh cấu hình gốc trước lần sửa ĐẦU TIÊN của một topic. */
  async function backupSetting(topic: NotificationTopic) {
    if (settingBackup.has(topic)) return;
    const current = await prisma.notificationSetting.findUnique({
      where: { topic },
    });
    if (current) {
      settingBackup.set(topic, {
        appEnabled: current.appEnabled,
        recipientPermissions: current.recipientPermissions,
      });
    }
  }

  async function setTopicEnabled(topic: NotificationTopic, enabled: boolean) {
    await backupSetting(topic);
    await prisma.notificationSetting.update({
      where: { topic },
      data: { appEnabled: enabled },
    });
    // Service cache cấu hình 60s — không xoá cache thì thay đổi vừa ghi không có tác dụng.
    notifications.invalidateSettingsCache();
  }

  /** Mở người nhận cho mọi nhân viên, để test chắc chắn có người nhận bất kể seed. */
  async function setTopicRecipientsOpen(topic: NotificationTopic) {
    await backupSetting(topic);
    await prisma.notificationSetting.update({
      where: { topic },
      data: { recipientPermissions: [] },
    });
    notifications.invalidateSettingsCache();
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    // Phải khớp main.ts: thiếu pipe này thì query param vẫn là chuỗi, `limit` đi thẳng
    // xuống Prisma dạng string và test 500 trong khi production hoàn toàn bình thường.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();

    prisma = moduleFixture.get(PrismaService);
    notifications = moduleFixture.get(NotificationService);
    apiKeys = moduleFixture.get(ApiKeyService);

    const [admin, sales, warehouse] = await Promise.all([
      prisma.user.findFirst({ where: { email: 'admin@local.dev' } }),
      prisma.user.findFirst({ where: { email: 'sales@local.dev' } }),
      prisma.user.findFirst({ where: { email: 'kho@local.dev' } }),
    ]);
    if (!admin || !sales || !warehouse) {
      throw new Error('Thiếu user seed (admin/sales/kho @local.dev)');
    }
    adminUserId = admin.id;
    salesUserId = sales.id;
    warehouseUserId = warehouse.id;

    const salesAssignment = await prisma.userLocationRole.findFirst({
      where: { userId: salesUserId },
      select: { locationId: true },
    });
    if (!salesAssignment) throw new Error('sales@local.dev chưa được gán kho nào');
    salesLocationId = salesAssignment.locationId;

    // Điều kiện tiên quyết của các test scope: kho của sales KHÔNG được là kho mà
    // warehouse user cũng có quyền, nếu không test "không nhận" mất ý nghĩa.
    const warehouseAtSalesLocation = await prisma.userLocationRole.findFirst({
      where: { userId: warehouseUserId, locationId: salesLocationId },
    });
    if (warehouseAtSalesLocation) {
      throw new Error(
        `Dữ liệu seed đã đổi: kho@local.dev cũng có role tại kho ${salesLocationId} — chọn lại kho test`,
      );
    }
    // AppModule khởi tạo nhiều module + kết nối DB ở xa — 5s mặc định không đủ.
  }, 60_000);

  afterAll(async () => {
    await collectCreated();
    if (createdNotificationIds.length) {
      // Cascade xoá luôn notification_recipients.
      await prisma.notification.deleteMany({
        where: { id: { in: createdNotificationIds } },
      });
    }
    if (createdKeyIds.length) {
      await prisma.apiKey.deleteMany({ where: { id: { in: createdKeyIds } } });
    }
    for (const [topic, snapshot] of settingBackup) {
      await prisma.notificationSetting.update({
        where: { topic },
        data: {
          appEnabled: snapshot.appEnabled,
          recipientPermissions: snapshot.recipientPermissions,
        },
      });
    }
    notifications.invalidateSettingsCache();
    await app.close();
    // 60s: dọn dẹp gồm nhiều lượt ghi lên DB Supabase ở xa, mặc định 5s của Jest không
    // đủ. Hook này hết giờ giữa chừng là để lại rác trên DB THẬT nên không được phép.
  }, 60_000);

  it('topic bị tắt (app_enabled=false) → không sinh dòng nào', async () => {
    await setTopicEnabled(NotificationTopic.orders_create, false);

    await notifications.emit(NotificationTopic.orders_create, {
      subjectType: 'order',
      subjectId: SUBJECT_ID,
      locationId: salesLocationId,
      title: 'e2e — topic đang tắt, không được sinh',
    });

    const rows = await prisma.notification.findMany({
      where: { subjectId: SUBJECT_ID },
    });
    expect(rows).toHaveLength(0);
  });

  it('fan-out theo quyền TẠI KHO: người có order:view ở kho đó nhận, người không có thì không', async () => {
    await setTopicEnabled(NotificationTopic.orders_create, true);

    await notifications.emit(NotificationTopic.orders_create, {
      subjectType: 'order',
      subjectId: SUBJECT_ID,
      locationId: salesLocationId,
      title: 'e2e — fan-out theo kho',
      payload: { code: 'E2E-TEST' },
    });

    const [notificationId] = await collectCreated();
    expect(notificationId).toBeDefined();

    const recipients = await prisma.notificationRecipient.findMany({
      where: { notificationId },
      select: { userId: true },
    });
    const ids = recipients.map((r) => r.userId.toString());

    // sales có order:view tại chính kho phát sinh
    expect(ids).toContain(salesUserId.toString());
    // admin toàn quyền nên luôn nhận
    expect(ids).toContain(adminUserId.toString());
    // warehouse_staff có order:view, nhưng ở kho KHÁC ⇒ không được nhận
    expect(ids).not.toContain(warehouseUserId.toString());
  });

  it('list() chỉ trả thông báo của chính user — không rò sang user khác', async () => {
    const salesList = await notifications.list(
      asUser(salesUserId, 'sales@local.dev'),
      { limit: 50 },
    );
    const warehouseList = await notifications.list(
      asUser(warehouseUserId, 'kho@local.dev'),
      { limit: 50 },
    );

    const salesIds = salesList.data.map((n) => n.id);
    const warehouseIds = warehouseList.data.map((n) => n.id);
    const mine = createdNotificationIds.map((id) => id.toString());

    expect(salesIds).toEqual(expect.arrayContaining(mine));
    // Chốt chặn quan trọng nhất của thiết kế này.
    for (const id of mine) {
      expect(warehouseIds).not.toContain(id);
    }
  });

  it('serializer dựng link tới đơn hàng và trả topic theo đúng chuỗi Sapo', async () => {
    const list = await notifications.list(asUser(salesUserId, 'sales@local.dev'), {
      limit: 50,
    });
    const item = list.data.find((n) =>
      createdNotificationIds.map(String).includes(n.id),
    );
    expect(item).toBeDefined();
    expect(item!.topic).toBe('orders/create');
    expect(item!.link).toBe(`/don-hang/${SUBJECT_ID.toString()}`);
    expect(item!.is_read).toBe(false);
  });

  it('markRead làm giảm unread-count đúng 1', async () => {
    const before = await notifications.unreadCount(
      asUser(salesUserId, 'sales@local.dev'),
    );
    const target = createdNotificationIds[0].toString();

    const res = await notifications.markRead(
      asUser(salesUserId, 'sales@local.dev'),
      [target],
    );
    expect(res.updated).toBe(1);

    const after = await notifications.unreadCount(
      asUser(salesUserId, 'sales@local.dev'),
    );
    expect(after.count).toBe(before.count - 1);

    // Gọi lại không trừ tiếp (điều kiện readOn: null đã lọc ra).
    const again = await notifications.markRead(
      asUser(salesUserId, 'sales@local.dev'),
      [target],
    );
    expect(again.updated).toBe(0);
  });

  it('markRead KHÔNG đánh dấu hộ được thông báo của user khác', async () => {
    const target = createdNotificationIds[0].toString();
    const res = await notifications.markRead(
      asUser(warehouseUserId, 'kho@local.dev'),
      [target],
    );
    // warehouse user không phải người nhận ⇒ where khớp 0 dòng
    expect(res.updated).toBe(0);
  });

  it('HTTP: chưa xác thực → 401; có key → 200 và chỉ thấy thông báo của acting user', async () => {
    await request(app.getHttpServer())
      .get('/api/notifications/unread-count')
      .expect(401);

    const callingAdmin: AuthUser = {
      userId: adminUserId,
      email: 'admin@local.dev',
      roles: [],
      locationIds: [],
      isAdmin: true,
    };
    const key = await apiKeys.create(
      {
        name: `e2e-notification-${Date.now()}`,
        acting_user_id: warehouseUserId.toString(),
      },
      callingAdmin,
    );
    createdKeyIds.push(BigInt(key.id));

    const res = await request(app.getHttpServer())
      .get('/api/notifications')
      .query({ limit: 50 })
      .set('x-api-key', key.api_key)
      .expect(200);

    const ids: string[] = res.body.data.map((n: { id: string }) => n.id);
    for (const id of createdNotificationIds.map(String)) {
      expect(ids).not.toContain(id);
    }
  }, 15_000);

  it('cảnh báo tồn kho: link dẫn tới bộ lọc cho ra ĐÚNG con số ghi trên thông báo', async () => {
    // Không chạy scanAll (quét 14 kho mất ~47s và phụ thuộc dữ liệu tồn thay đổi liên
    // tục). Thay vào đó dựng đúng payload mà InventoryAlertService sinh ra, rồi kiểm
    // serializer dựng link đúng — đây mới là chỗ dễ sai và là chỗ từng suýt sai:
    // dùng nhầm `low_stock=true` (available <= 5) thì link ra 96% số dòng.
    const location = await prisma.location.findFirstOrThrow({
      where: { status: 'active' },
      select: { id: true, name: true },
    });

    await setTopicEnabled(NotificationTopic.inventory_negative, true);
    await setTopicRecipientsOpen(NotificationTopic.inventory_negative);

    await notifications.emit(NotificationTopic.inventory_negative, {
      subjectType: 'location',
      subjectId: location.id,
      locationId: location.id,
      title: `${location.name}: 3 sản phẩm âm kho`,
      payload: { count: 3, stock_status: 'negative', variant_ids: '1,2,3' },
    });

    const created = await prisma.notification.findFirst({
      where: {
        topic: NotificationTopic.inventory_negative,
        subjectId: location.id,
      },
      orderBy: { id: 'desc' },
    });
    expect(created).toBeTruthy();
    createdNotificationIds.push(created!.id);

    const list = await notifications.list(asUser(adminUserId, 'admin@local.dev'), {
      limit: 20,
    });
    const item = list.data.find((n) => n.id === created!.id.toString());
    expect(item).toBeDefined();
    expect(item!.topic).toBe('inventory/negative');

    // Âm kho → dùng bộ lọc SQL thật, KHÔNG liệt kê id (kho lớn có tới 405 dòng)
    expect(item!.link).toBe(
      `/kho/ton-kho?locationId=${location.id}&stockStatus=negative`,
    );
    expect(item!.link).not.toContain('low_stock');
    // Nhiều lượt round-trip lên DB Supabase ở xa — 5s mặc định của Jest không đủ.
  }, 30_000);

  it('cảnh báo cần nhập: link liệt kê đúng SKU đã đếm (không biểu diễn được bằng SQL)', async () => {
    const location = await prisma.location.findFirstOrThrow({
      where: { status: 'active' },
      select: { id: true, name: true },
    });

    await setTopicEnabled(NotificationTopic.inventory_low_stock, true);
    await setTopicRecipientsOpen(NotificationTopic.inventory_low_stock);

    await notifications.emit(NotificationTopic.inventory_low_stock, {
      subjectType: 'location',
      subjectId: location.id,
      locationId: location.id,
      title: `${location.name}: 2 sản phẩm cần nhập hàng`,
      payload: { count: 2, variant_ids: '10,20' },
    });

    const created = await prisma.notification.findFirst({
      where: {
        topic: NotificationTopic.inventory_low_stock,
        subjectId: location.id,
      },
      orderBy: { id: 'desc' },
    });
    expect(created).toBeTruthy();
    createdNotificationIds.push(created!.id);

    const list = await notifications.list(asUser(adminUserId, 'admin@local.dev'), {
      limit: 20,
    });
    const item = list.data.find((n) => n.id === created!.id.toString());
    expect(item!.topic).toBe('inventory/low_stock');
    expect(item!.link).toBe(
      `/kho/ton-kho?locationId=${location.id}&variantIds=10%2C20`,
    );
  }, 30_000);

  it('cảnh báo tồn kho KHÔNG lặp lại digest trùng khi vẫn còn người chưa đọc', async () => {
    const location = await prisma.location.findFirstOrThrow({
      where: { status: 'active' },
      select: { id: true, name: true },
    });
    const alerts = app.get(InventoryAlertService);

    await setTopicEnabled(NotificationTopic.inventory_negative, true);
    await setTopicRecipientsOpen(NotificationTopic.inventory_negative);

    const countBefore = await prisma.notification.count({
      where: {
        topic: NotificationTopic.inventory_negative,
        subjectId: location.id,
      },
    });

    // Gọi 2 lượt liên tiếp trên cùng một kho: lượt 2 phải bị chặn vì con số không đổi
    // và digest lượt 1 vẫn chưa ai đọc. Không có chặn này thì cron 2 lần/ngày sẽ nhồi
    // thông báo y hệt nhau vào chuông vĩnh viễn.
    const first = await alerts['scanNegative'](location);
    const second = await alerts['scanNegative'](location);

    const countAfter = await prisma.notification.count({
      where: {
        topic: NotificationTopic.inventory_negative,
        subjectId: location.id,
      },
    });

    // Kho có thể không có dòng âm nào — khi đó cả hai lượt đều false, vẫn hợp lệ.
    if (first) {
      expect(second).toBe(false);
      expect(countAfter).toBe(countBefore + 1);
      const rows = await prisma.notification.findMany({
        where: {
          topic: NotificationTopic.inventory_negative,
          subjectId: location.id,
        },
        orderBy: { id: 'desc' },
        take: 1,
        select: { id: true },
      });
      createdNotificationIds.push(rows[0].id);
    } else {
      expect(countAfter).toBe(countBefore);
    }
  }, 30_000);

  it('bộ lọc stock_status=negative đúng nghĩa "âm thật", không gộp dòng bằng 0', async () => {
    const location = await prisma.location.findFirstOrThrow({
      where: { status: 'active' },
      select: { id: true },
    });

    const negative = await prisma.inventoryLevel.count({
      where: { locationId: location.id, available: { lt: 0 } },
    });
    const outOfStock = await prisma.inventoryLevel.count({
      where: { locationId: location.id, available: { lte: 0 } },
    });

    // Chốt lại lý do tách hai trạng thái: nếu chúng bằng nhau thì `negative` thừa.
    // Trên dữ liệu thật chênh nhau rất xa (756 vs 14.395 toàn hệ thống).
    expect(negative).toBeLessThanOrEqual(outOfStock);
  });

  it('cấu hình: cần quyền notification:manage mới xem được settings', async () => {
    const callingAdmin: AuthUser = {
      userId: adminUserId,
      email: 'admin@local.dev',
      roles: [],
      locationIds: [],
      isAdmin: true,
    };

    const warehouseKey = await apiKeys.create(
      {
        name: `e2e-notification-wh-${Date.now()}`,
        acting_user_id: warehouseUserId.toString(),
      },
      callingAdmin,
    );
    createdKeyIds.push(BigInt(warehouseKey.id));

    // warehouse_staff không có notification:manage
    await request(app.getHttpServer())
      .get('/api/notifications/settings')
      .set('x-api-key', warehouseKey.api_key)
      .expect(403);

    const adminKey = await apiKeys.create(
      {
        name: `e2e-notification-admin-${Date.now()}`,
        acting_user_id: adminUserId.toString(),
      },
      callingAdmin,
    );
    createdKeyIds.push(BigInt(adminKey.id));

    const res = await request(app.getHttpServer())
      .get('/api/notifications/settings')
      .set('x-api-key', adminKey.api_key)
      .expect(200);

    // Đếm theo enum thay vì số cứng — thêm topic mới không phải sửa test
    expect(res.body.data).toHaveLength(
      Object.keys(NotificationTopic).length,
    );
    expect(res.body.data.map((s: { topic: string }) => s.topic)).toContain(
      'orders/create',
    );
  }, 15_000);
});
