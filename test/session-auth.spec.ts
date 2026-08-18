/**
 * SessionService — phiên đăng nhập lưu ở server.
 *
 * Token phát cho client là chuỗi ngẫu nhiên KHÔNG mang thông tin: nó không tự chứng minh
 * được gì, chỉ hợp lệ khi đối chiếu ra một dòng còn sống. Ba tính chất phải giữ:
 *
 *   1. Thu hồi một phiên là tức thì, và KHÔNG đụng thiết bị khác của cùng người.
 *   2. Database chỉ giữ hash — rò database không kéo theo mạo danh được ai.
 *   3. Mọi lý do từ chối trả về như nhau, không tiết lộ token nào từng là thật.
 */
import { createHash } from 'crypto';
import { SessionService } from '../src/modules/auth/session.service';
import { AuthCacheService } from '../src/modules/rbac/auth-cache.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { RbacService } from '../src/modules/rbac/rbac.service';

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

/** JSON.stringify không nuốt được BigInt — mà dữ liệu phiên toàn id kiểu bigint. */
const dump = (v: unknown) =>
  JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val));

const RAW = 'ses_abcdef0123456789';

const activeUser = {
  id: 7n,
  email: 'u@test',
  active: true,
  status: 'active',
  roles: ['sales'],
};

const liveSession = {
  id: 42n,
  userId: 7n,
  tokenHash: hash(RAW),
  revokedAt: null as Date | null,
  expiresAt: new Date(Date.now() + 3_600_000),
  lastSeenAt: new Date(),
  user: activeUser,
};

const resolved = {
  adminWarehouseIds: [],
  warehousePermissions: { '1': ['order:view'] },
  locationIds: [1n],
  systemPermissions: ['dashboard:view'],
  permissions: [],
  isAdmin: false,
};

function build(session: unknown = liveSession) {
  const prisma = {
    userSession: {
      create: jest.fn().mockResolvedValue({ id: 99n }),
      findUnique: jest.fn().mockResolvedValue(session),
      findFirst: jest.fn().mockResolvedValue(session),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  } as unknown as PrismaService;
  const rbac = {
    resolvePermissions: jest.fn().mockResolvedValue(resolved),
  } as unknown as RbacService;
  const cache = new AuthCacheService();
  return { service: new SessionService(prisma, rbac, cache), prisma, rbac, cache };
}

describe('phát hành phiên', () => {
  it('token thô KHÔNG bao giờ được lưu — chỉ lưu SHA-256', async () => {
    const { service, prisma } = build();
    const { token } = await service.create(7n);

    const saved = (prisma.userSession.create as jest.Mock).mock.calls[0][0].data;
    expect(saved.tokenHash).toBe(hash(token));
    expect(dump(saved)).not.toContain(token);
  });

  it('mỗi lần gọi ra token khác nhau', async () => {
    const { service } = build();
    const a = await service.create(7n);
    const b = await service.create(7n);
    expect(a.token).not.toBe(b.token);
  });

  it('token đủ dài và mang tiền tố nhận diện', async () => {
    const { service } = build();
    const { token } = await service.create(7n);
    expect(token.startsWith('ses_')).toBe(true);
    // 32 byte ngẫu nhiên -> 43 ký tự base64url. Không có gì để dò ngược vì token
    // không phải chữ ký của cái gì cả.
    expect(token.length).toBeGreaterThanOrEqual(40);
  });

  it('ghi lại thiết bị để người dùng nhận ra phiên của mình', async () => {
    const { service, prisma } = build();
    await service.create(7n, { userAgent: 'Chrome/mac', ipAddress: '1.2.3.4' });
    const saved = (prisma.userSession.create as jest.Mock).mock.calls[0][0].data;
    expect(saved.userAgent).toBe('Chrome/mac');
    expect(saved.ipAddress).toBe('1.2.3.4');
  });

  it('user-agent dài bị cắt, không để client bơm dữ liệu tuỳ ý vào DB', async () => {
    const { service, prisma } = build();
    await service.create(7n, { userAgent: 'x'.repeat(5000) });
    const saved = (prisma.userSession.create as jest.Mock).mock.calls[0][0].data;
    expect(saved.userAgent.length).toBe(500);
  });
});

describe('giải mã phiên — từ chối', () => {
  it('token không khớp phiên nào -> null', async () => {
    const { service } = build(null);
    await expect(service.resolveAuthUser('ses_bia-dat')).resolves.toBeNull();
  });

  it('phiên đã thu hồi -> null', async () => {
    const { service } = build({ ...liveSession, revokedAt: new Date() });
    await expect(service.resolveAuthUser(RAW)).resolves.toBeNull();
  });

  it('phiên hết hạn -> null', async () => {
    const { service } = build({
      ...liveSession,
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(service.resolveAuthUser(RAW)).resolves.toBeNull();
  });

  it('tài khoản bị khoá -> null dù phiên còn sống', async () => {
    const { service } = build({
      ...liveSession,
      user: { ...activeUser, active: false },
    });
    await expect(service.resolveAuthUser(RAW)).resolves.toBeNull();
  });

  it('tài khoản status=inactive -> null', async () => {
    const { service } = build({
      ...liveSession,
      user: { ...activeUser, status: 'inactive' },
    });
    await expect(service.resolveAuthUser(RAW)).resolves.toBeNull();
  });

  it('không throw ở bất kỳ đường từ chối nào — guard tự chọn mã lỗi', async () => {
    const { service } = build(null);
    await expect(service.resolveAuthUser('ses_bia')).resolves.toBeNull();
  });

  it('tra bằng hash, không bao giờ tra bằng token thô', async () => {
    const { service, prisma } = build();
    await service.resolveAuthUser(RAW);
    expect(prisma.userSession.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: hash(RAW) },
      include: { user: true },
    });
  });
});

describe('giải mã phiên — chấp nhận', () => {
  it('dựng AuthUser kèm sessionId để còn tự đăng xuất được', async () => {
    const { service } = build();
    const user = await service.resolveAuthUser(RAW);
    expect(user).toMatchObject({
      userId: 7n,
      sessionId: 42n,
      email: 'u@test',
      systemPermissions: ['dashboard:view'],
    });
  });

  it('nhớ vào cache theo hash token, không phải theo userId', async () => {
    const { service, cache } = build();
    await service.resolveAuthUser(RAW);
    expect(cache.get(hash(RAW))).toBeDefined();
  });

  it('lần sau dùng lại cache, không tra DB nữa', async () => {
    const { service, prisma } = build();
    await service.resolveAuthUser(RAW);
    await service.resolveAuthUser(RAW);
    expect(prisma.userSession.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('thu hồi', () => {
  it('thu hồi phiên -> đánh dấu revokedAt VÀ xoá cache ngay', async () => {
    // Thiếu bước xoá cache thì token vừa thu hồi vẫn đi lọt tới hết TTL 30s.
    const { service, prisma, cache } = build();
    await service.resolveAuthUser(RAW);
    expect(cache.get(hash(RAW))).toBeDefined();

    const ok = await service.revoke(42n, 7n);

    expect(ok).toBe(true);
    expect(prisma.userSession.update).toHaveBeenCalledWith({
      where: { id: 42n },
      data: { revokedAt: expect.any(Date) },
    });
    expect(cache.get(hash(RAW))).toBeUndefined();
  });

  it('thu hồi MỘT phiên không đụng thiết bị khác của cùng người', async () => {
    // Đây chính là thứ mô hình phiên mua được so với JWT + tokenVersion: đá một thiết
    // bị mà các thiết bị còn lại vẫn đăng nhập bình thường. Phải kiểm ở tầng service,
    // không chỉ ở tầng cache — gọi nhầm invalidateUser sẽ giết sạch mà vẫn "chạy đúng".
    const RAW_B = 'ses_thiet-bi-thu-hai';
    const sessionB = { ...liveSession, id: 43n, tokenHash: hash(RAW_B) };

    const { service, prisma, cache } = build();
    (prisma.userSession.findUnique as jest.Mock).mockImplementation(
      ({ where }: { where: { tokenHash: string } }) =>
        Promise.resolve(
          where.tokenHash === hash(RAW_B) ? sessionB : liveSession,
        ),
    );

    await service.resolveAuthUser(RAW);
    await service.resolveAuthUser(RAW_B);
    expect(cache.get(hash(RAW))).toBeDefined();
    expect(cache.get(hash(RAW_B))).toBeDefined();

    // Thu hồi đúng phiên A.
    (prisma.userSession.findFirst as jest.Mock).mockResolvedValue(liveSession);
    await service.revoke(42n, 7n);

    expect(cache.get(hash(RAW))).toBeUndefined();
    expect(cache.get(hash(RAW_B))).toBeDefined();
  });

  it('chỉ thu hồi được phiên CỦA MÌNH — lọc theo userId', async () => {
    const { service, prisma } = build();
    await service.revoke(42n, 7n);
    expect(prisma.userSession.findFirst).toHaveBeenCalledWith({
      where: { id: 42n, userId: 7n, revokedAt: null },
    });
  });

  it('thu hồi phiên người khác -> false, không đụng gì', async () => {
    const { service, prisma } = build(null);
    await expect(service.revoke(42n, 999n)).resolves.toBe(false);
    expect(prisma.userSession.update).not.toHaveBeenCalled();
  });

  it('thu hồi tất cả nhưng GIỮ phiên đang thao tác', async () => {
    // Bấm "đăng xuất mọi thiết bị" mà tự đá luôn mình là hành vi gây bất ngờ.
    const { service, prisma } = build();
    await service.revokeAll(7n, 42n);
    expect(prisma.userSession.updateMany).toHaveBeenCalledWith({
      where: { userId: 7n, revokedAt: null, id: { not: 42n } },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('thu hồi tất cả không chừa ai khi không truyền phiên hiện tại', async () => {
    const { service, prisma } = build();
    await service.revokeAll(7n);
    expect(prisma.userSession.updateMany).toHaveBeenCalledWith({
      where: { userId: 7n, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('thu hồi tất cả xoá cache của MỌI phiên người đó', async () => {
    const { service, cache } = build();
    await service.resolveAuthUser(RAW);
    await service.revokeAll(7n);
    expect(cache.get(hash(RAW))).toBeUndefined();
  });
});

describe('liệt kê thiết bị', () => {
  it('chỉ lấy phiên còn sống của chính mình', async () => {
    const { service, prisma } = build();
    await service.list(7n);
    const args = (prisma.userSession.findMany as jest.Mock).mock.calls[0][0];
    expect(args.where.userId).toBe(7n);
    expect(args.where.revokedAt).toBeNull();
    expect(args.where.expiresAt).toEqual({ gt: expect.any(Date) });
  });

  it('đánh dấu đúng thiết bị đang dùng và KHÔNG lộ hash token', async () => {
    const { service, prisma } = build();
    (prisma.userSession.findMany as jest.Mock).mockResolvedValue([
      { ...liveSession, id: 42n, createdAt: new Date(), userAgent: 'A' },
      { ...liveSession, id: 43n, createdAt: new Date(), userAgent: 'B' },
    ]);

    const out = await service.list(7n, 42n);

    expect(out.data.map((s) => s.is_current)).toEqual([true, false]);
    expect(dump(out)).not.toContain(hash(RAW));
  });
});
