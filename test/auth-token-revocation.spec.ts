/**
 * Thu hồi token bằng `tokenVersion`.
 *
 * Hệ thống không lưu phiên phía server và JWT không mang `jti`, nên trước đây một
 * token đã phát không có cách nào vô hiệu hoá ngoài việc khoá cả tài khoản. Số hiệu
 * phiên bản gắn vào đúng lượt tra DB mà `JwtStrategy` vốn đã chạy mỗi request.
 *
 * Ca quan trọng nhất ở đây là nhánh CACHE: cache quyền đánh khoá theo userId nên dùng
 * chung cho mọi token của cùng một user. Nếu chỉ đối chiếu ở nhánh tra DB thì sau khi
 * thu hồi, user đăng nhập lại là entry cache mới được nạp, và token cũ bám vào đó đi
 * lọt cho tới khi hết TTL.
 */
import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import { AuthService } from '../src/modules/auth/auth.service';
import { JwtStrategy } from '../src/modules/auth/jwt.strategy';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { RbacService } from '../src/modules/rbac/rbac.service';
import type { AuthCacheService } from '../src/modules/rbac/auth-cache.service';
import type { AuthUser } from '../src/common/decorators/current-user.decorator';

const userRow = {
  id: 7n,
  email: 'u@test',
  firstName: 'A',
  lastName: 'B',
  active: true,
  status: 'active',
  passwordHash: 'hash',
  roles: ['sales'],
  tokenVersion: 3,
};

const resolved = {
  adminWarehouseIds: [],
  warehousePermissions: { '1': ['order:view'] },
  locationIds: [1n],
  systemPermissions: ['dashboard:view'],
  permissions: [],
  isAdmin: false,
};

/** requireEnv từ chối secret dưới 32 ký tự — mock phải dùng giá trị hợp lệ. */
const FAKE_SECRET = 'x'.repeat(44);

function buildStrategy(opts: {
  user?: unknown;
  cached?: AuthUser | undefined;
}) {
  const config = { get: jest.fn().mockReturnValue(FAKE_SECRET) } as unknown as ConfigService;
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(opts.user ?? userRow) },
  } as unknown as PrismaService;
  const rbac = {
    resolvePermissions: jest.fn().mockResolvedValue(resolved),
  } as unknown as RbacService;
  const authCache = {
    get: jest.fn().mockReturnValue(opts.cached),
    set: jest.fn(),
    invalidate: jest.fn(),
  } as unknown as AuthCacheService;
  return { strategy: new JwtStrategy(config, prisma, rbac, authCache), authCache };
}

describe('JwtStrategy — đối chiếu tokenVersion', () => {
  it('ver khớp -> cho qua và nhớ vào cache kèm phiên bản', async () => {
    const { strategy, authCache } = buildStrategy({});
    const user = await strategy.validate({ sub: '7', email: 'u@test', ver: 3 });

    expect(user.userId).toBe(7n);
    expect(user.tokenVersion).toBe(3);
    expect(authCache.set).toHaveBeenCalledWith(
      '7',
      expect.objectContaining({ tokenVersion: 3 }),
    );
  });

  it('ver cũ hơn (đã thu hồi) -> 401', async () => {
    const { strategy } = buildStrategy({});
    await expect(
      strategy.validate({ sub: '7', email: 'u@test', ver: 2 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('token đời cũ không có ver, user chưa từng thu hồi -> vẫn cho qua', async () => {
    // Không đá hàng loạt token đang lưu hành ngay lúc triển khai.
    const { strategy } = buildStrategy({ user: { ...userRow, tokenVersion: 0 } });
    const user = await strategy.validate({ sub: '7', email: 'u@test' });
    expect(user.userId).toBe(7n);
  });

  it('token đời cũ không có ver nhưng user ĐÃ thu hồi -> 401', async () => {
    const { strategy } = buildStrategy({});
    await expect(
      strategy.validate({ sub: '7', email: 'u@test' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('nhánh cache: token đã thu hồi không bám được vào entry của token mới', async () => {
    // Cache do một token hợp lệ (ver 3) nạp lên; token cũ ver 2 phải bị chặn dù
    // không hề chạm tới DB.
    const cached = {
      userId: 7n,
      email: 'u@test',
      roles: ['sales'],
      locationIds: [1n],
      tokenVersion: 3,
    } as AuthUser;
    const { strategy } = buildStrategy({ cached });

    await expect(
      strategy.validate({ sub: '7', email: 'u@test', ver: 2 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // ver khớp thì vẫn dùng lại cache bình thường
    await expect(
      strategy.validate({ sub: '7', email: 'u@test', ver: 3 }),
    ).resolves.toBe(cached);
  });

  it('tài khoản bị khoá -> 401 bất kể ver', async () => {
    const { strategy } = buildStrategy({ user: { ...userRow, active: false } });
    await expect(
      strategy.validate({ sub: '7', email: 'u@test', ver: 3 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AuthService — phát hành và thu hồi', () => {
  function build() {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(userRow),
        update: jest.fn().mockResolvedValue({ ...userRow, tokenVersion: 4 }),
      },
    } as unknown as PrismaService;
    const jwt = { signAsync: jest.fn().mockResolvedValue('tok') } as unknown as JwtService;
    const rbac = {
      resolvePermissions: jest.fn().mockResolvedValue(resolved),
    } as unknown as RbacService;
    const authCache = { invalidate: jest.fn() } as unknown as AuthCacheService;
    return { auth: new AuthService(prisma, jwt, rbac, authCache), prisma, jwt, authCache };
  }

  it('login ký kèm ver hiện tại của user', async () => {
    const { auth, jwt } = build();
    jest
      .spyOn(await import('bcrypt'), 'compare')
      .mockImplementation(() => Promise.resolve(true) as never);

    await auth.login('u@test', 'pw');

    expect(jwt.signAsync).toHaveBeenCalledWith({
      sub: '7',
      email: 'u@test',
      ver: 3,
    });
  });

  it('revokeAllSessions tăng phiên bản VÀ xoá cache', async () => {
    const { auth, prisma, authCache } = build();
    const result = await auth.revokeAllSessions(7n);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 7n },
      data: { tokenVersion: { increment: 1 } },
    });
    // Thiếu bước này thì token vừa thu hồi vẫn đi lọt tới hết TTL cache 30s.
    expect(authCache.invalidate).toHaveBeenCalledWith(7n);
    expect(result).toEqual({ data: { revoked: true, token_version: 4 } });
  });
});
