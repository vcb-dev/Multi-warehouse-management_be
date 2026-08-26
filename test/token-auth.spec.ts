/**
 * TokenService — cặp access/refresh token.
 *
 * Bốn tính chất phải giữ, mỗi cái đều là một cách hỏng đã thấy ngoài đời:
 *
 *   1. Hai token KHÔNG thay nhau được. Cùng khoá ký, nên thiếu claim `typ` là một refresh
 *      token sống 7 ngày dùng thẳng làm access token cũng lọt.
 *   2. Xoay vòng: dùng một refresh token là nó chết, và dùng lại nó lần nữa (quá cửa sổ
 *      ân hạn) bị coi là token bị đánh cắp → giết cả họ.
 *   3. Đăng xuất phải giết được access token CÒN HẠN, không chỉ chặn gia hạn.
 *   4. Database chỉ giữ hash — rò database không kéo theo mạo danh được ai.
 */
import { createHash } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { TokenService } from '../src/modules/auth/token.service';
import { AuthCacheService } from '../src/modules/rbac/auth-cache.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { RbacService } from '../src/modules/rbac/rbac.service';

const SECRET = 'test-secret-du-dai-de-khong-bi-tu-choi-32';
const ISSUER = 'vcb-api';

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

/** JSON.stringify không nuốt được BigInt — mà dữ liệu token toàn id kiểu bigint. */
const dump = (v: unknown) =>
  JSON.stringify(v, (_k, val) =>
    typeof val === 'bigint' ? val.toString() : val,
  );

const activeUser = {
  id: 7n,
  email: 'u@test',
  active: true,
  status: 'active',
  roles: ['sales'],
};

const resolved = {
  adminWarehouseIds: [],
  warehousePermissions: { '1': ['order:view'] },
  locationIds: [1n],
  systemPermissions: ['dashboard:view'],
  permissions: [],
  isAdmin: false,
};

type Row = {
  id: bigint;
  userId: bigint;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
};

/**
 * Prisma giả nhưng có trí nhớ: `rotate` đọc dòng vừa ghi ở lượt trước, nên mock trả cứng
 * một giá trị sẽ không diễn được cảnh xoay vòng — đúng cảnh cần kiểm nhất.
 */
function build(opts: { user?: unknown } = {}) {
  const rows: Row[] = [];
  let nextId = 1n;

  const prisma = {
    refreshToken: {
      create: jest.fn(
        ({ data }: { data: Omit<Row, 'id' | 'usedAt' | 'revokedAt'> }) => {
          const row: Row = {
            ...data,
            id: nextId++,
            usedAt: null,
            revokedAt: null,
          };
          rows.push(row);
          return Promise.resolve(row);
        },
      ),
      findUnique: jest.fn(({ where }: { where: { tokenHash: string } }) =>
        Promise.resolve(
          rows.find((r) => r.tokenHash === where.tokenHash) ?? null,
        ),
      ),
      findFirst: jest.fn(({ where }: { where: { familyId: string } }) =>
        Promise.resolve(
          rows.find(
            (r) =>
              r.familyId === where.familyId &&
              r.revokedAt === null &&
              r.expiresAt.getTime() > Date.now(),
          ) ?? null,
        ),
      ),
      updateMany: jest.fn(
        ({
          where,
          data,
        }: {
          where: {
            id?: bigint;
            familyId?: string;
            usedAt?: null;
            revokedAt?: null;
          };
          data: Partial<Row>;
        }) => {
          const hit = rows.filter(
            (r) =>
              (where.id === undefined || r.id === where.id) &&
              (where.familyId === undefined || r.familyId === where.familyId) &&
              (where.usedAt === undefined || r.usedAt === null) &&
              (where.revokedAt === undefined || r.revokedAt === null),
          );
          for (const r of hit) Object.assign(r, data);
          return Promise.resolve({ count: hit.length });
        },
      ),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue('user' in opts ? opts.user : activeUser),
    },
  } as unknown as PrismaService;

  const rbac = {
    resolvePermissions: jest.fn().mockResolvedValue(resolved),
  } as unknown as RbacService;
  const cache = new AuthCacheService();
  const jwt = new JwtService({
    secret: SECRET,
    signOptions: { issuer: ISSUER },
  });

  return {
    service: new TokenService(prisma, rbac, cache, jwt),
    prisma,
    rbac,
    cache,
    jwt,
    rows,
  };
}

describe('phát hành cặp token', () => {
  it('refresh token thô KHÔNG bao giờ được lưu — chỉ lưu SHA-256', async () => {
    const { service, prisma } = build();
    const pair = await service.issueForLogin(7n);

    const saved = (prisma.refreshToken.create as jest.Mock).mock.calls[0][0]
      .data as Row;
    expect(saved.tokenHash).toBe(hash(pair.refreshToken));
    expect(dump(saved)).not.toContain(pair.refreshToken);
  });

  it('access token KHÔNG được lưu ở đâu cả — nó tự chứng minh', async () => {
    const { service, prisma } = build();
    const pair = await service.issueForLogin(7n);
    expect(
      dump((prisma.refreshToken.create as jest.Mock).mock.calls),
    ).not.toContain(pair.accessToken);
  });

  it('hai token khác nhau nhưng cùng một họ', async () => {
    const { service, rows } = build();
    const pair = await service.issueForLogin(7n);
    expect(pair.accessToken).not.toBe(pair.refreshToken);
    expect(rows[0].familyId).toBe(pair.familyId);
  });

  it('mỗi lần đăng nhập là một họ mới — đăng xuất máy này không đụng máy kia', async () => {
    const { service } = build();
    const a = await service.issueForLogin(7n);
    const b = await service.issueForLogin(7n);
    expect(a.familyId).not.toBe(b.familyId);
  });

  it('access token hết hạn TRƯỚC refresh token', async () => {
    const { service } = build();
    const pair = await service.issueForLogin(7n);
    expect(pair.accessExpiresAt.getTime()).toBeLessThan(
      pair.refreshExpiresAt.getTime(),
    );
  });

  it('access token không chở quyền hay email — chỉ đủ để tra lại', async () => {
    // Quyền nằm trong token thì thu hồi quyền phải chờ token hết hạn. Ở đây quyền được
    // resolve lại ở `resolveAuthUser`, nên đổi role có hiệu lực trong ~30 giây.
    const { service, jwt } = build();
    const pair = await service.issueForLogin(7n);
    const claims = jwt.decode(pair.accessToken) as Record<string, unknown>;

    expect(claims.sub).toBe('7');
    expect(claims.typ).toBe('access');
    expect(dump(claims)).not.toContain('dashboard:view');
    expect(dump(claims)).not.toContain('u@test');
  });

  it('ghi lại thiết bị để còn tra được khi điều tra sự cố', async () => {
    const { service, rows } = build();
    await service.issueForLogin(7n, {
      userAgent: 'Chrome/mac',
      ipAddress: '1.2.3.4',
    });
    expect(rows[0]).toMatchObject({
      userAgent: 'Chrome/mac',
      ipAddress: '1.2.3.4',
    });
  });

  it('user-agent dài bị cắt, không để client bơm dữ liệu tuỳ ý vào DB', async () => {
    const { service, prisma } = build();
    await service.issueForLogin(7n, { userAgent: 'x'.repeat(5000) });
    const saved = (prisma.refreshToken.create as jest.Mock).mock.calls[0][0]
      .data as { userAgent: string };
    expect(saved.userAgent.length).toBe(500);
  });
});

describe('hai loại token không thay nhau được', () => {
  it('refresh token KHÔNG dùng làm access token được', async () => {
    // Cùng khoá ký nên chữ ký hợp lệ; chỉ claim `typ` chặn lại. Thiếu nó là kẻ đọc được
    // refresh cookie có ngay một access token sống 7 ngày.
    const { service } = build();
    const pair = await service.issueForLogin(7n);
    await expect(
      service.resolveAuthUser(pair.refreshToken),
    ).resolves.toBeNull();
  });

  it('access token KHÔNG dùng để gia hạn được', async () => {
    const { service } = build();
    const pair = await service.issueForLogin(7n);
    await expect(service.rotate(pair.accessToken)).resolves.toBeNull();
  });
});

describe('giải mã access token — từ chối', () => {
  it('chuỗi bịa -> null', async () => {
    const { service } = build();
    await expect(service.resolveAuthUser('khong-phai-jwt')).resolves.toBeNull();
  });

  it('token ký bằng khoá khác -> null', async () => {
    const { service } = build();
    const pair = await service.issueForLogin(7n);
    const other = new JwtService({
      secret: 'khoa-khac-cung-du-dai-32-ky-tu-nhe',
    });
    const forged = other.sign(
      { sub: '7', sid: 'gia-mao', typ: 'access' },
      { issuer: ISSUER, expiresIn: 900 },
    );
    expect(forged).not.toBe(pair.accessToken);
    await expect(service.resolveAuthUser(forged)).resolves.toBeNull();
  });

  it('token sai `iss` -> null', async () => {
    const { service, jwt } = build();
    const foreign = jwt.sign(
      { sub: '7', sid: 'x', typ: 'access' },
      { issuer: 'he-thong-khac', expiresIn: 900 },
    );
    await expect(service.resolveAuthUser(foreign)).resolves.toBeNull();
  });

  it('token hết hạn -> null', async () => {
    const { service, jwt } = build();
    const stale = jwt.sign(
      { sub: '7', sid: 'x', typ: 'access' },
      { issuer: ISSUER, expiresIn: -10 },
    );
    await expect(service.resolveAuthUser(stale)).resolves.toBeNull();
  });

  it('tài khoản bị khoá -> null dù token còn hạn', async () => {
    const { service } = build({ user: { ...activeUser, active: false } });
    const pair = await service.issueForLogin(7n);
    await expect(service.resolveAuthUser(pair.accessToken)).resolves.toBeNull();
  });

  it('tài khoản status=inactive -> null', async () => {
    const { service } = build({ user: { ...activeUser, status: 'inactive' } });
    const pair = await service.issueForLogin(7n);
    await expect(service.resolveAuthUser(pair.accessToken)).resolves.toBeNull();
  });

  it('họ đã thu hồi -> null, dù access token còn hạn', async () => {
    // Đây là điều duy nhất khiến đăng xuất có ý nghĩa với token tự chứng minh.
    const { service } = build();
    const pair = await service.issueForLogin(7n);
    await service.revokeFamily(pair.familyId);
    await expect(service.resolveAuthUser(pair.accessToken)).resolves.toBeNull();
  });

  it('không throw ở bất kỳ đường từ chối nào — guard tự chọn mã lỗi', async () => {
    const { service } = build();
    await expect(service.resolveAuthUser('a.b.c')).resolves.toBeNull();
  });
});

describe('giải mã access token — chấp nhận', () => {
  it('dựng AuthUser kèm familyId để còn đăng xuất được', async () => {
    const { service } = build();
    const pair = await service.issueForLogin(7n);
    await expect(
      service.resolveAuthUser(pair.accessToken),
    ).resolves.toMatchObject({
      userId: 7n,
      familyId: pair.familyId,
      email: 'u@test',
      systemPermissions: ['dashboard:view'],
    });
  });

  it('nhớ vào cache theo họ, không phải theo userId', async () => {
    const { service, cache } = build();
    const pair = await service.issueForLogin(7n);
    await service.resolveAuthUser(pair.accessToken);
    expect(cache.get('sid:' + pair.familyId)).toBeDefined();
  });

  it('lần sau dùng lại cache, không tra DB nữa', async () => {
    const { service, prisma } = build();
    const pair = await service.issueForLogin(7n);
    await service.resolveAuthUser(pair.accessToken);
    (prisma.user.findUnique as jest.Mock).mockClear();
    await service.resolveAuthUser(pair.accessToken);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('xoay vòng refresh token', () => {
  it('đổi được lấy cặp mới, giữ nguyên họ', async () => {
    const { service } = build();
    const first = await service.issueForLogin(7n);
    const out = await service.rotate(first.refreshToken);

    expect(out?.userId).toBe(7n);
    expect(out?.pair.familyId).toBe(first.familyId);
    expect(out?.pair.refreshToken).not.toBe(first.refreshToken);
    expect(out?.pair.accessToken).not.toBe(first.accessToken);
  });

  it('token vừa dùng bị đánh dấu đã tiêu', async () => {
    const { service, rows } = build();
    const first = await service.issueForLogin(7n);
    await service.rotate(first.refreshToken);
    expect(rows[0].usedAt).toBeInstanceOf(Date);
  });

  it('cặp mới vẫn đăng nhập được ngay sau khi xoay', async () => {
    const { service } = build();
    const first = await service.issueForLogin(7n);
    const out = await service.rotate(first.refreshToken);
    await expect(
      service.resolveAuthUser(out!.pair.accessToken),
    ).resolves.toMatchObject({ userId: 7n });
  });

  it('dùng lại token đã tiêu (quá ân hạn) -> null VÀ giết cả họ', async () => {
    // Bản thật đã xoay đi từ lâu; ai còn cầm bản cũ là người đã copy được nó. Không biết
    // bên nào là chủ, nên giết hết: chủ máy mất một lần gõ mật khẩu, kẻ trộm mất tất cả.
    const { service, rows } = build();
    const first = await service.issueForLogin(7n);
    const second = await service.rotate(first.refreshToken);

    rows[0].usedAt = new Date(Date.now() - 60_000);

    await expect(service.rotate(first.refreshToken)).resolves.toBeNull();
    // Cặp mới — thứ mà chủ máy thật đang cầm — cũng chết theo.
    await expect(service.rotate(second!.pair.refreshToken)).resolves.toBeNull();
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it('dùng lại token đã tiêu TRONG ân hạn -> vẫn cấp cặp mới, không giết họ', async () => {
    // Hai tab cùng phát hiện token hết hạn và cùng gọi refresh là chuyện bình thường.
    // Xử nghiêm ngay lượt thứ hai là đá người dùng ra vì chính hành vi hợp lệ của họ.
    const { service, rows } = build();
    const first = await service.issueForLogin(7n);
    await service.rotate(first.refreshToken);

    const again = await service.rotate(first.refreshToken);
    expect(again).not.toBeNull();
    expect(rows.some((r) => r.revokedAt !== null)).toBe(false);
  });

  it('token đã thu hồi -> null và giết lại cả họ cho chắc', async () => {
    const { service, rows } = build();
    const first = await service.issueForLogin(7n);
    rows[0].revokedAt = new Date();

    await expect(service.rotate(first.refreshToken)).resolves.toBeNull();
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it('dòng đã hết hạn -> null (không chỉ dựa vào `exp` trong chữ ký)', async () => {
    const { service, rows } = build();
    const first = await service.issueForLogin(7n);
    rows[0].expiresAt = new Date(Date.now() - 1000);
    await expect(service.rotate(first.refreshToken)).resolves.toBeNull();
  });

  it('chữ ký hợp lệ nhưng không có dòng nào -> null, không giết oan ai', async () => {
    const { service, jwt, rows } = build();
    const orphan = jwt.sign(
      { sub: '7', sid: 'ho-khong-ton-tai', typ: 'refresh', jti: 'x' },
      { issuer: ISSUER, expiresIn: 3600 },
    );
    await expect(service.rotate(orphan)).resolves.toBeNull();
    expect(rows).toHaveLength(0);
  });

  it('tài khoản bị khoá -> null VÀ cắt luôn đường gia hạn', async () => {
    const { service, prisma, rows } = build();
    const first = await service.issueForLogin(7n);
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      ...activeUser,
      active: false,
    });

    await expect(service.rotate(first.refreshToken)).resolves.toBeNull();
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
  });
});

describe('thu hồi họ (đăng xuất)', () => {
  it('đánh dấu revokedAt VÀ xoá cache ngay', async () => {
    // Thiếu bước xoá cache thì access token vừa đăng xuất vẫn đi lọt tới hết TTL 30s.
    const { service, cache, rows } = build();
    const pair = await service.issueForLogin(7n);
    await service.resolveAuthUser(pair.accessToken);
    expect(cache.get('sid:' + pair.familyId)).toBeDefined();

    const count = await service.revokeFamily(pair.familyId);

    expect(count).toBe(1);
    expect(rows[0].revokedAt).toBeInstanceOf(Date);
    expect(cache.get('sid:' + pair.familyId)).toBeUndefined();
  });

  it('thu hồi MỘT họ không đụng thiết bị khác của cùng người', async () => {
    // Gọi nhầm `invalidateUser` sẽ giết sạch mọi thiết bị mà vẫn "chạy đúng" ở test cache.
    const { service, cache } = build();
    const a = await service.issueForLogin(7n);
    const b = await service.issueForLogin(7n);
    await service.resolveAuthUser(a.accessToken);
    await service.resolveAuthUser(b.accessToken);

    await service.revokeFamily(a.familyId);

    expect(cache.get('sid:' + a.familyId)).toBeUndefined();
    expect(cache.get('sid:' + b.familyId)).toBeDefined();
    await expect(service.resolveAuthUser(b.accessToken)).resolves.toMatchObject(
      {
        userId: 7n,
      },
    );
  });

  it('thu hồi họ đã chết -> 0, không lỗi', async () => {
    const { service } = build();
    const pair = await service.issueForLogin(7n);
    await service.revokeFamily(pair.familyId);
    await expect(service.revokeFamily(pair.familyId)).resolves.toBe(0);
  });

  it('đọc được họ từ CẢ access lẫn refresh token để đăng xuất', async () => {
    const { service } = build();
    const pair = await service.issueForLogin(7n);
    expect(service.familyOf(pair.refreshToken)).toBe(pair.familyId);
    // Refresh cookie chỉ được gửi cho `/api/auth` nên có lúc vắng mặt. Cả hai token đều
    // chở cùng `familyId`, nên nhận cả hai thì đăng xuất không phụ thuộc vào cookie nào
    // còn sống — bỏ sót là họ token sống tiếp tới hết 7 ngày.
    expect(service.familyOf(pair.accessToken)).toBe(pair.familyId);
    expect(service.familyOf('rac')).toBeNull();
  });
});
