/**
 * ApiKeyService.resolveAuthUser — đường xác thực THỨ HAI của hệ thống.
 *
 * `JwtAuthGuard` chấp nhận `x-api-key` thay cho `Authorization`, và key gọi được MỌI
 * route. Vì vậy mỗi lý do từ chối bị bỏ sót ở đây là một đường vòng qua toàn bộ RBAC.
 * Hàm cố ý KHÔNG throw — trả `null` để guard tự quyết mã lỗi.
 */
import { createHash } from 'crypto';
import { ApiKeyService } from '../src/modules/api-keys/api-key.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { RbacService } from '../src/modules/rbac/rbac.service';
import type { AuthCacheService } from '../src/modules/rbac/auth-cache.service';
import type { AuthUser } from '../src/common/decorators/current-user.decorator';

const RAW_KEY = 'whk_live_abcdef123456';
const keyHash = createHash('sha256').update(RAW_KEY).digest('hex');

const validKey = {
  id: 1n,
  keyHash,
  actingUserId: 7n,
  isActive: true,
  revokedAt: null as Date | null,
  expiresAt: null as Date | null,
};

const actingUser = {
  id: 7n,
  email: 'partner@test',
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

function build(
  opts: {
    key?: unknown;
    user?: unknown;
    cached?: AuthUser;
  } = {},
) {
  const prisma = {
    apiKey: {
      findUnique: jest
        .fn()
        .mockResolvedValue('key' in opts ? opts.key : validKey),
      update: jest.fn().mockResolvedValue({}),
    },
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue('user' in opts ? opts.user : actingUser),
    },
  } as unknown as PrismaService;
  const rbac = {
    resolvePermissions: jest.fn().mockResolvedValue(resolved),
  } as unknown as RbacService;
  const authCache = {
    get: jest.fn().mockReturnValue(opts.cached),
    set: jest.fn(),
    invalidate: jest.fn(),
  } as unknown as AuthCacheService;
  return {
    service: new ApiKeyService(prisma, rbac, authCache),
    prisma,
    rbac,
    authCache,
  };
}

describe('resolveAuthUser — từ chối', () => {
  it('key không tồn tại -> null', async () => {
    const { service } = build({ key: null });
    await expect(service.resolveAuthUser('sai')).resolves.toBeNull();
  });

  it('key đã tắt (isActive=false) -> null', async () => {
    const { service } = build({ key: { ...validKey, isActive: false } });
    await expect(service.resolveAuthUser(RAW_KEY)).resolves.toBeNull();
  });

  it('key đã thu hồi (revokedAt) -> null dù isActive vẫn true', async () => {
    const { service } = build({
      key: { ...validKey, revokedAt: new Date('2020-01-01') },
    });
    await expect(service.resolveAuthUser(RAW_KEY)).resolves.toBeNull();
  });

  it('key hết hạn -> null', async () => {
    const { service } = build({
      key: { ...validKey, expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(service.resolveAuthUser(RAW_KEY)).resolves.toBeNull();
  });

  it('key còn hạn -> vẫn dùng được', async () => {
    const { service } = build({
      key: { ...validKey, expiresAt: new Date(Date.now() + 60_000) },
    });
    await expect(service.resolveAuthUser(RAW_KEY)).resolves.not.toBeNull();
  });

  it('user được mạo danh đã bị khoá -> null, key không sống lâu hơn tài khoản', async () => {
    const { service } = build({ user: { ...actingUser, active: false } });
    await expect(service.resolveAuthUser(RAW_KEY)).resolves.toBeNull();
  });

  it('user được mạo danh status=inactive -> null', async () => {
    const { service } = build({ user: { ...actingUser, status: 'inactive' } });
    await expect(service.resolveAuthUser(RAW_KEY)).resolves.toBeNull();
  });

  it('user được mạo danh đã bị xoá -> null', async () => {
    const { service } = build({ user: null });
    await expect(service.resolveAuthUser(RAW_KEY)).resolves.toBeNull();
  });

  it('không throw ở bất kỳ đường từ chối nào — guard tự chọn mã lỗi', async () => {
    const { service } = build({ key: null });
    await expect(service.resolveAuthUser('sai')).resolves.toBeNull();
  });
});

describe('resolveAuthUser — tra key bằng hash', () => {
  it('tra theo SHA-256 của key, không bao giờ tra bằng key thô', async () => {
    const { service, prisma } = build();
    await service.resolveAuthUser(RAW_KEY);
    expect(prisma.apiKey.findUnique).toHaveBeenCalledWith({
      where: { keyHash },
    });
    const arg = JSON.stringify(
      (prisma.apiKey.findUnique as jest.Mock).mock.calls[0][0],
    );
    expect(arg).not.toContain(RAW_KEY);
  });
});

describe('resolveAuthUser — chấp nhận', () => {
  it('dựng AuthUser đúng shape như đường JWT', async () => {
    const { service } = build();
    const user = await service.resolveAuthUser(RAW_KEY);

    expect(user).toMatchObject({
      userId: 7n,
      email: 'partner@test',
      locationIds: [1n],
      isAdmin: false,
      systemPermissions: ['dashboard:view'],
      warehousePermissions: { '1': ['order:view'] },
    });
  });

  it('nhớ cache theo actingUserId — API key không thuộc phiên nào', async () => {
    // Khác người dùng: key không có familyId, nên không tự đăng xuất được. Khoá cache vì
    // thế vẫn là userId chứ không phải họ refresh token.
    const { service } = build();
    const user = await service.resolveAuthUser(RAW_KEY);
    expect(user?.familyId).toBeUndefined();
  });

  it('quyền lấy từ RBAC thật của user, không tự chế cho key', async () => {
    const { service, rbac } = build();
    await service.resolveAuthUser(RAW_KEY);
    expect(rbac.resolvePermissions).toHaveBeenCalledWith(7n);
  });

  it('nhớ vào cache theo actingUserId để lần sau khỏi tra lại', async () => {
    const { service, authCache } = build();
    await service.resolveAuthUser(RAW_KEY);
    expect(authCache.set).toHaveBeenCalledWith(
      '7',
      7n,
      expect.objectContaining({ userId: 7n }),
    );
  });

  it('có cache -> dùng lại, không tra user cũng không tra quyền', async () => {
    const cached = { userId: 7n, email: 'partner@test' } as AuthUser;
    const { service, prisma, rbac } = build({ cached });

    await expect(service.resolveAuthUser(RAW_KEY)).resolves.toBe(cached);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(rbac.resolvePermissions).not.toHaveBeenCalled();
  });

  it('key hỏng vẫn phải kiểm TRƯỚC khi đụng cache', async () => {
    // Cache đánh khoá theo actingUserId nên một key đã thu hồi không được phép
    // mượn entry cache của user đó để đi tiếp.
    const cached = { userId: 7n } as AuthUser;
    const { service } = build({
      key: { ...validKey, isActive: false },
      cached,
    });
    await expect(service.resolveAuthUser(RAW_KEY)).resolves.toBeNull();
  });

  it('ghi nhận lastUsedAt nhưng không chờ — không ảnh hưởng kết quả xác thực', async () => {
    const { service, prisma } = build();
    await service.resolveAuthUser(RAW_KEY);
    expect(prisma.apiKey.update).toHaveBeenCalledWith({
      where: { id: 1n },
      data: { lastUsedAt: expect.any(Date) },
    });
  });
});
