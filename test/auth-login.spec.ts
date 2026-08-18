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
import type { SessionService } from '../src/modules/auth/session.service';

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
  const sessions = {
    create: jest.fn().mockResolvedValue({
      token: 'ses_token-moi',
      sessionId: 42n,
      expiresAt: new Date('2026-08-25T00:00:00.000Z'),
    }),
  } as unknown as SessionService;
  return { auth: new AuthService(prisma, rbac, sessions), sessions, rbac };
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

  it('không tạo phiên ở bất kỳ đường từ chối nào', async () => {
    allowPassword(false);
    const { auth, sessions } = build();
    await auth.login('u@test', 'pw').catch(() => undefined);
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('không tra quyền cho tài khoản đã bị khoá — hỏng sớm, đỡ tốn query', async () => {
    const { auth, rbac } = build({ ...activeUser, active: false });
    await auth.login('u@test', 'pw').catch(() => undefined);
    expect(rbac.resolvePermissions).not.toHaveBeenCalled();
  });
});

describe('AuthService.login — thành công', () => {
  beforeEach(() => allowPassword(true));

  it('trả access_token kèm payload quyền đúng shape FE parse', async () => {
    const { auth } = build();
    const result = await auth.login('u@test', 'pw');

    expect(result).toEqual({
      access_token: 'ses_token-moi',
      expires_at: '2026-08-25T00:00:00.000Z',
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

  it('id kiểu BigInt được đổi sang chuỗi — JSON không tuần tự hoá được BigInt', async () => {
    const { auth } = build();
    const result = await auth.login('u@test', 'pw');
    expect(typeof result.user.id).toBe('string');
    expect(result.user.location_ids.every((v) => typeof v === 'string')).toBe(
      true,
    );
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('KHÔNG trả passwordHash ra ngoài', async () => {
    const { auth } = build();
    const result = await auth.login('u@test', 'pw');
    expect(JSON.stringify(result)).not.toContain('hash-that-bcrypt');
  });

  it('token là chuỗi đục gắn với phiên, không phải JWT mang dữ liệu', async () => {
    // Đây là điểm mấu chốt của mô hình phiên: token không tự chứng minh được gì, nên
    // không có khoá ký nào để dò ngược, và thu hồi là đánh dấu một dòng chứ không
    // phải chờ hết hạn.
    const { auth, sessions } = build();
    const result = await auth.login('u@test', 'pw');

    expect(sessions.create).toHaveBeenCalledWith(7n, {});
    expect(result.access_token).toBe('ses_token-moi');
    // Không mang thông tin: tách bằng dấu chấm kiểu JWT sẽ không ra 3 phần.
    expect(result.access_token.split('.')).toHaveLength(1);
  });

  it('trả kèm hạn phiên để FE khớp thời gian sống của cookie', async () => {
    const { auth } = build();
    const result = await auth.login('u@test', 'pw');
    expect(result.expires_at).toBe('2026-08-25T00:00:00.000Z');
  });
});
