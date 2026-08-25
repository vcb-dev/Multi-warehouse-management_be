/**
 * Rìa HTTP của luồng auth: chỗ token đi vào (guard đọc từ đâu) và đi ra (controller đặt
 * cookie nào). Hai đầu này không có test thì lỗi chỉ lộ khi bấm thử trên trình duyệt.
 */
import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { AuthController } from '../src/modules/auth/auth.controller';
import type { AuthService } from '../src/modules/auth/auth.service';
import type { InvitationService } from '../src/modules/rbac/invitation.service';
import { JwtAuthGuard } from '../src/common/guards/auth.guards';
import type { ApiKeyService } from '../src/modules/api-keys/api-key.service';
import type { TokenService } from '../src/modules/auth/token.service';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../src/common/auth/cookies';
import { adminAuth } from './helpers/auth';

const issued = {
  accessToken: 'access.jwt',
  accessExpiresAt: new Date('2026-08-22T00:15:00.000Z'),
  refreshToken: 'refresh.jwt',
  refreshExpiresAt: new Date('2026-08-29T00:00:00.000Z'),
  familyId: 'ho-1',
};

const payload = {
  user: { id: '7', email: 'u@test' },
  expires_at: '2026-08-29T00:00:00.000Z',
};

function fakeRes() {
  const set: string[] = [];
  const cleared: string[] = [];
  const res = {
    cookie: jest.fn((name: string) => set.push(name)),
    clearCookie: jest.fn((name: string) => cleared.push(name)),
  } as unknown as Response;
  return { res, set, cleared };
}

function buildController(over: Partial<AuthService> = {}) {
  const auth = {
    login: jest.fn().mockResolvedValue({ tokens: issued, body: payload }),
    refresh: jest.fn().mockResolvedValue({ tokens: issued, body: payload }),
    logout: jest.fn().mockResolvedValue(true),
    me: jest.fn(),
    ...over,
  } as unknown as AuthService;
  const invitations = {} as InvitationService;
  return { controller: new AuthController(auth, invitations), auth };
}

const req = (cookies: Record<string, string> = {}) => ({
  headers: { 'user-agent': 'Chrome' },
  cookies,
  ip: '1.2.3.4',
});

describe('POST /auth/login', () => {
  it('đặt cả hai cookie và KHÔNG trả token trong body', async () => {
    const { controller } = buildController();
    const { res, set } = fakeRes();

    const body = await controller.login(
      { email: 'u@test', password: 'pw' },
      req(),
      res,
    );

    expect(set.sort()).toEqual([ACCESS_COOKIE, REFRESH_COOKIE].sort());
    expect(JSON.stringify(body)).not.toContain('access.jwt');
    expect(JSON.stringify(body)).not.toContain('refresh.jwt');
  });

  it('chuyển tiếp user-agent/IP để còn tra lại khi điều tra sự cố', async () => {
    const { controller, auth } = buildController();
    const { res } = fakeRes();
    await controller.login({ email: 'u@test', password: 'pw' }, req(), res);
    expect(auth.login).toHaveBeenCalledWith('u@test', 'pw', {
      userAgent: 'Chrome',
      ipAddress: '1.2.3.4',
    });
  });
});

describe('POST /auth/refresh', () => {
  it('đọc refresh token từ cookie, không phải từ body', async () => {
    // Nhận qua body nghĩa là JavaScript của trang phải cầm được token — đúng thứ mà
    // httpOnly sinh ra để ngăn.
    const { controller, auth } = buildController();
    const { res } = fakeRes();
    await controller.refresh(req({ [REFRESH_COOKIE]: 'refresh.cu' }), res);
    expect(auth.refresh).toHaveBeenCalledWith('refresh.cu', {
      userAgent: 'Chrome',
      ipAddress: '1.2.3.4',
    });
  });

  it('gia hạn thành công thì thay cả hai cookie', async () => {
    const { controller } = buildController();
    const { res, set } = fakeRes();
    await controller.refresh(req({ [REFRESH_COOKIE]: 'refresh.cu' }), res);
    expect(set.sort()).toEqual([ACCESS_COOKIE, REFRESH_COOKIE].sort());
  });

  it('gia hạn hỏng thì XOÁ cookie rồi mới ném lỗi', async () => {
    // Để cookie chết nằm lại thì mọi request sau đó vẫn mang nó đi và vẫn 401 — người
    // dùng kẹt ở màn hình trắng cho tới khi tự xoá cookie bằng tay.
    const { controller } = buildController({
      refresh: jest.fn().mockRejectedValue(new UnauthorizedException()),
    });
    const { res, cleared } = fakeRes();

    await expect(
      controller.refresh(req({ [REFRESH_COOKIE]: 'het-han' }), res),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(cleared.sort()).toEqual([ACCESS_COOKIE, REFRESH_COOKIE].sort());
  });
});

describe('POST /auth/logout', () => {
  it('thu hồi họ token rồi xoá cookie', async () => {
    const { controller, auth } = buildController();
    const { res, cleared } = fakeRes();

    const out = await controller.logout(
      req({ [REFRESH_COOKIE]: 'refresh.cu', [ACCESS_COOKIE]: 'access.cu' }),
      res,
    );

    // Đưa xuống CẢ HAI: refresh cookie chỉ được gửi cho `/api/auth` nên có lúc vắng mặt,
    // và khi đó access cookie là thứ duy nhất còn đọc ra được `familyId`.
    expect(auth.logout).toHaveBeenCalledWith('refresh.cu', 'access.cu');
    expect(cleared.sort()).toEqual([ACCESS_COOKIE, REFRESH_COOKIE].sort());
    expect(out).toEqual({ data: { logged_out: true } });
  });

  it('mất refresh cookie nhưng còn access cookie -> vẫn thu hồi được họ', async () => {
    const { controller, auth } = buildController();
    const { res } = fakeRes();

    await controller.logout(req({ [ACCESS_COOKIE]: 'access.cu' }), res);

    // Không có dòng này thì đăng xuất chỉ là xoá cookie trên máy NÀY, còn họ token sống
    // tiếp tới hết 7 ngày.
    expect(auth.logout).toHaveBeenCalledWith(undefined, 'access.cu');
  });

  it('không còn cookie nào vẫn xoá sạch và trả 200', async () => {
    // Bấm đăng xuất mà nhận lỗi là kịch bản tệ nhất: người dùng tưởng mình vẫn đang đăng
    // nhập. Ở đây không có gì để thu hồi, nhưng cookie vẫn phải biến mất.
    const { controller } = buildController({
      logout: jest.fn().mockResolvedValue(false),
    });
    const { res, cleared } = fakeRes();

    const out = await controller.logout(req(), res);

    expect(cleared).toHaveLength(2);
    expect(out).toEqual({ data: { logged_out: false } });
  });
});

describe('JwtAuthGuard — đọc access token từ đâu', () => {
  function buildGuard(resolved: unknown = adminAuth({ familyId: 'ho-1' })) {
    const tokens = {
      resolveAuthUser: jest.fn().mockResolvedValue(resolved),
    } as unknown as TokenService;
    const apiKeys = {
      resolveAuthUser: jest.fn().mockResolvedValue(adminAuth()),
    } as unknown as ApiKeyService;
    return {
      guard: new JwtAuthGuard(new Reflector(), apiKeys, tokens),
      tokens,
      apiKeys,
    };
  }

  const ctx = (request: unknown) =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
    }) as never;

  it('lấy token từ cookie khi trình duyệt gửi lên', async () => {
    const { guard, tokens } = buildGuard();
    const request = { headers: {}, cookies: { [ACCESS_COOKIE]: 'tu-cookie' } };
    await expect(guard.canActivate(ctx(request))).resolves.toBe(true);
    expect(tokens.resolveAuthUser).toHaveBeenCalledWith('tu-cookie');
  });

  it('vẫn nhận Bearer header cho Swagger/script không có cookie jar', async () => {
    const { guard, tokens } = buildGuard();
    const request = { headers: { authorization: 'Bearer tu-header' } };
    await expect(guard.canActivate(ctx(request))).resolves.toBe(true);
    expect(tokens.resolveAuthUser).toHaveBeenCalledWith('tu-header');
  });

  it('có cả hai thì cookie thắng — đó là đường của trình duyệt', async () => {
    const { guard, tokens } = buildGuard();
    const request = {
      headers: { authorization: 'Bearer tu-header' },
      cookies: { [ACCESS_COOKIE]: 'tu-cookie' },
    };
    await guard.canActivate(ctx(request));
    expect(tokens.resolveAuthUser).toHaveBeenCalledWith('tu-cookie');
  });

  it('cookie rỗng không che mất Bearer header', async () => {
    // Trình duyệt vẫn gửi cookie rỗng sau khi bị xoá. Coi chuỗi rỗng là "có token" sẽ
    // chặn luôn đường header.
    const { guard, tokens } = buildGuard();
    const request = {
      headers: { authorization: 'Bearer tu-header' },
      cookies: { [ACCESS_COOKIE]: '' },
    };
    await guard.canActivate(ctx(request));
    expect(tokens.resolveAuthUser).toHaveBeenCalledWith('tu-header');
  });

  it('x-api-key đi đường riêng, không đụng tới token phiên', async () => {
    const { guard, tokens, apiKeys } = buildGuard();
    const request = {
      headers: { 'x-api-key': 'whk_live_x' },
      cookies: { [ACCESS_COOKIE]: 'tu-cookie' },
    };
    await guard.canActivate(ctx(request));
    expect(apiKeys.resolveAuthUser).toHaveBeenCalledWith('whk_live_x');
    expect(tokens.resolveAuthUser).not.toHaveBeenCalled();
  });

  it('không có token nào -> 401', async () => {
    const { guard } = buildGuard();
    await expect(
      guard.canActivate(ctx({ headers: {}, cookies: {} })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('token không giải mã được -> 401', async () => {
    const { guard } = buildGuard(null);
    const request = { headers: {}, cookies: { [ACCESS_COOKIE]: 'rac' } };
    await expect(guard.canActivate(ctx(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
