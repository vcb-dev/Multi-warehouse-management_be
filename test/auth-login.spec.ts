/**
 * AuthService.login — cổng vào duy nhất phát hành token.
 *
 * Điểm cần giữ: mọi lý do từ chối phải trả CÙNG một thông báo. Phân biệt "email không
 * tồn tại" với "sai mật khẩu" là biếu không cho người dò một cách liệt kê tài khoản có
 * thật, sau đó chỉ cần tập trung dò mật khẩu của những email đã xác nhận.
 */
import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from '../src/modules/auth/auth.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { RbacService } from '../src/modules/rbac/rbac.service';
import type { TokenService } from '../src/modules/auth/token.service';

const activeUser = {
  id: 7n,
  email: 'u@test',
  firstName: 'Nguyễn',
  lastName: 'Văn A',
  active: true,
  status: 'active',
  passwordHash: 'hash-that-bcrypt-would-produce',
  roles: ['sales'],
  tokenVersion: 0,
};

const resolved = {
  adminWarehouseIds: [2n],
  warehousePermissions: { '1': ['order:view'] },
  locationIds: [1n],
  systemPermissions: ['dashboard:view'],
  permissions: [],
  isAdmin: true,
};

function build(userRow: unknown = activeUser) {
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(userRow) },
  } as unknown as PrismaService;
  const rbac = {
    resolvePermissions: jest.fn().mockResolvedValue(resolved),
  } as unknown as RbacService;
  const tokens = {
    issueForLogin: jest.fn().mockResolvedValue({
      accessToken: 'access.jwt.moi',
      accessExpiresAt: new Date('2026-08-22T00:15:00.000Z'),
      refreshToken: 'refresh.jwt.moi',
      refreshExpiresAt: new Date('2026-08-29T00:00:00.000Z'),
      familyId: 'ho-1',
    }),
  } as unknown as TokenService;
  return { auth: new AuthService(prisma, rbac, tokens), tokens, rbac };
}

function allowPassword(ok: boolean) {
  jest
    .spyOn(bcrypt, 'compare')
    .mockImplementation(() => Promise.resolve(ok) as never);
}

afterEach(() => jest.restoreAllMocks());

describe('AuthService.login — từ chối', () => {
  it('email không tồn tại -> Unauthorized', async () => {
    const { auth } = build(null);
    await expect(auth.login('khong-co@test', 'pw')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('tài khoản bị vô hiệu hoá (active=false) -> Unauthorized', async () => {
    const { auth } = build({ ...activeUser, active: false });
    await expect(auth.login('u@test', 'pw')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('tài khoản status=inactive -> Unauthorized', async () => {
    const { auth } = build({ ...activeUser, status: 'inactive' });
    await expect(auth.login('u@test', 'pw')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('sai mật khẩu -> Unauthorized', async () => {
    allowPassword(false);
    const { auth } = build();
    await expect(auth.login('u@test', 'sai')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('email không tồn tại và sai mật khẩu trả CÙNG thông báo', async () => {
    // Lệch thông báo là lộ email nào có thật trong hệ thống.
    allowPassword(false);
    const notFound = await build(null)
      .auth.login('x@test', 'pw')
      .catch((e: Error) => e.message);
    const wrongPass = await build()
      .auth.login('u@test', 'pw')
      .catch((e: Error) => e.message);
    expect(notFound).toBe(wrongPass);
  });

  it('tài khoản mời nhưng chưa đặt mật khẩu -> báo riêng, KHÔNG lộ gì thêm', async () => {
    // Ca này lộ ra email có tồn tại, nhưng đó là đánh đổi có chủ đích: người dùng
    // cần biết phải đi tìm email lời mời thay vì ngồi thử lại mật khẩu.
    const { auth } = build({ ...activeUser, passwordHash: null });
    await expect(auth.login('u@test', 'pw')).rejects.toThrow(/kích hoạt/i);
  });

  it('không phát token ở bất kỳ đường từ chối nào', async () => {
    allowPassword(false);
    const { auth, tokens } = build();
    await auth.login('u@test', 'pw').catch(() => undefined);
    expect(tokens.issueForLogin).not.toHaveBeenCalled();
  });

  it('không tra quyền cho tài khoản đã bị khoá — hỏng sớm, đỡ tốn query', async () => {
    const { auth, rbac } = build({ ...activeUser, active: false });
    await auth.login('u@test', 'pw').catch(() => undefined);
    expect(rbac.resolvePermissions).not.toHaveBeenCalled();
  });
});

describe('AuthService.login — thành công', () => {
  beforeEach(() => allowPassword(true));

  it('trả payload quyền đúng shape FE parse', async () => {
    const { auth } = build();
    const result = await auth.login('u@test', 'pw');

    expect(result.body).toEqual({
      expires_at: '2026-08-29T00:00:00.000Z',
      user: {
        id: '7',
        email: 'u@test',
        name: 'Nguyễn Văn A',
        roles: ['sales'],
        location_ids: ['1'],
        warehouse_permissions: { '1': ['order:view'] },
        admin_location_ids: ['2'],
        permissions: ['dashboard:view'],
        is_admin: true,
      },
    });
  });

  it('KHÔNG trả token trong body — cả hai chỉ đi bằng cookie httpOnly', async () => {
    // Trả thêm một bản trong body là tự tay huỷ lợi ích của httpOnly: chỉ cần một lỗ XSS
    // là token bị đọc và mang đi.
    const { auth } = build();
    const result = await auth.login('u@test', 'pw');

    expect(JSON.stringify(result.body)).not.toContain('access.jwt.moi');
    expect(JSON.stringify(result.body)).not.toContain('refresh.jwt.moi');
    expect(result.body).not.toHaveProperty('access_token');
    expect(result.body).not.toHaveProperty('refresh_token');
  });

  it('token đi kèm riêng để controller đặt cookie', async () => {
    const { auth } = build();
    const result = await auth.login('u@test', 'pw');
    expect(result.tokens).toMatchObject({
      accessToken: 'access.jwt.moi',
      refreshToken: 'refresh.jwt.moi',
      familyId: 'ho-1',
    });
  });

  it('id kiểu BigInt được đổi sang chuỗi — JSON không tuần tự hoá được BigInt', async () => {
    const { auth } = build();
    const { body } = await auth.login('u@test', 'pw');
    expect(typeof body.user.id).toBe('string');
    expect(
      body.user.location_ids.every((v: string) => typeof v === 'string'),
    ).toBe(true);
    expect(() => JSON.stringify(body)).not.toThrow();
  });

  it('KHÔNG trả passwordHash ra ngoài', async () => {
    const { auth } = build();
    const result = await auth.login('u@test', 'pw');
    expect(JSON.stringify(result.body)).not.toContain('hash-that-bcrypt');
  });

  it('`expires_at` là hạn của REFRESH token, không phải access token', async () => {
    // Đây là mốc người dùng thật sự phải gõ lại mật khẩu. Lấy nhầm hạn access token là
    // FE tưởng phiên chết sau 15 phút và đá người dùng ra oan.
    const { auth } = build();
    const { body } = await auth.login('u@test', 'pw');
    expect(body.expires_at).toBe('2026-08-29T00:00:00.000Z');
  });

  it('phát token gắn với đúng user và mang theo thông tin thiết bị', async () => {
    const { auth, tokens } = build();
    await auth.login('u@test', 'pw', {
      userAgent: 'Chrome',
      ipAddress: '1.2.3.4',
    });
    expect(tokens.issueForLogin).toHaveBeenCalledWith(7n, {
      userAgent: 'Chrome',
      ipAddress: '1.2.3.4',
    });
  });
});
