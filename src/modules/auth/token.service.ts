import { createHash, randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';
import { AuthCacheService } from '../rbac/auth-cache.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { JWT_ISSUER, accessTtlMs, refreshTtlMs } from './jwt.config';

/**
 * Hai token cùng khoá ký, nên phải phân biệt được nhau: thiếu claim này thì một refresh
 * token (sống 7 ngày) dùng thẳng làm access token cũng lọt, và toàn bộ ý nghĩa của TTL
 * ngắn biến mất.
 */
const ACCESS_TYPE = 'access';
const REFRESH_TYPE = 'refresh';

/**
 * Hai tab cùng phát hiện access token hết hạn và cùng gọi refresh trong tích tắc là
 * chuyện bình thường. Xử nghiêm ngay lượt thứ hai thì người dùng bị đá ra vì chính hành
 * vi hợp lệ của mình. Trong cửa sổ này, dùng lại một dòng vừa tiêu được coi là cuộc đua
 * lành tính và cấp cặp mới; quá cửa sổ mới coi là token bị đánh cắp.
 */
const REUSE_GRACE_MS = 10_000;

/** Tách khoá cache của phiên đăng nhập khỏi khoá của API key trong cùng một Map. */
const CACHE_PREFIX = 'sid:';

export type SessionContext = {
  userAgent?: string;
  ipAddress?: string;
};

export type TokenPair = {
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
  familyId: string;
};

type TokenClaims = { sub: string; sid: string; typ: string; jti: string };

function hash(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Phát hành, xác minh và xoay vòng cặp access/refresh token.
 *
 * Chia việc rành mạch giữa hai token:
 *
 *   - **Access token** — JWT ngắn hạn, tự chứng minh. Đường nóng của mọi request chỉ
 *     verify chữ ký, không tra database. Cái giá là không rút lại được: đã ký thì còn
 *     hiệu lực tới lúc hết hạn.
 *   - **Refresh token** — JWT dài hạn nhưng CHỈ hợp lệ khi khớp một dòng còn sống trong
 *     `refresh_tokens`. Dùng xong là dòng đó chết và một dòng mới thay chỗ (xoay vòng).
 *     Đây là chỗ duy nhất còn thu hồi được.
 *
 * Nối hai nửa lại là `familyId`: mọi refresh token sinh ra từ cùng một lần đăng nhập
 * mang chung giá trị này, và access token chở nó ở claim `sid`. Nhờ vậy giết một họ vừa
 * chặn được refresh tiếp, vừa vô hiệu access token còn hạn (xem `resolveAuthUser`) —
 * đăng xuất không phải chờ hết TTL.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private prisma: PrismaService,
    private rbac: RbacService,
    private authCache: AuthCacheService,
    private jwt: JwtService,
  ) {}

  /**
   * Cặp token cho một lần đăng nhập mới. `familyId` sinh ở đây và theo phiên tới lúc
   * đăng xuất; mọi lượt xoay vòng sau đó dùng lại đúng giá trị này.
   */
  async issueForLogin(
    userId: bigint,
    ctx: SessionContext = {},
  ): Promise<TokenPair> {
    return this.issuePair(userId, randomUUID(), ctx);
  }

  /**
   * Đổi refresh token lấy cặp mới.
   *
   * Trả `null` cho MỌI lý do từ chối — controller tự quyết mã lỗi. Cố ý không phân biệt
   * "chữ ký sai" với "đã bị thu hồi": nói rõ là xác nhận giúp kẻ tấn công rằng token họ
   * nhặt được từng là thật.
   */
  async rotate(
    rawToken: string,
    ctx: SessionContext = {},
  ): Promise<{ userId: bigint; pair: TokenPair } | null> {
    const claims = this.verify(rawToken, REFRESH_TYPE);
    if (!claims) return null;

    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hash(rawToken) },
    });
    // Chữ ký hợp lệ mà không có dòng nào: họ đã bị dọn sạch, không còn gì để giết thêm.
    if (!row) return null;

    if (row.revokedAt) {
      // Đã thu hồi mà vẫn có người cầm đi dùng — nếu là chủ máy thì họ đã bị đăng xuất
      // rồi. Giết lại cả họ cho chắc, phòng trường hợp mới thu hồi được một phần.
      await this.revokeFamily(row.familyId);
      return null;
    }
    if (row.expiresAt.getTime() <= Date.now()) return null;

    if (row.usedAt && Date.now() - row.usedAt.getTime() > REUSE_GRACE_MS) {
      // Token này đã đổi lấy cặp mới từ lâu. Bản thật đã xoay đi, nên người đang cầm bản
      // cũ là người đã copy được nó. Không biết trong hai bên ai là chủ, nên giết cả họ
      // và bắt đăng nhập lại — chủ máy mất một lần gõ mật khẩu, kẻ trộm mất tất cả.
      await this.revokeFamily(row.familyId);
      return null;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: row.userId },
    });
    if (!user || !user.active || user.status === 'inactive') {
      // Khoá tài khoản phải cắt được cả đường gia hạn, không chỉ chặn đăng nhập mới.
      await this.revokeFamily(row.familyId);
      return null;
    }

    // Chốt dòng cũ là đã tiêu. Thua cuộc đua (`count === 0`) nghĩa là một request khác
    // vừa tiêu nó xong, tức vẫn nằm trong cửa sổ ân hạn — đi tiếp, không coi là tấn công.
    await this.prisma.refreshToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    const pair = await this.issuePair(row.userId, row.familyId, ctx);
    // Cặp mới không đổi quyền, nhưng quyền có thể đã đổi ở BE từ lần cache trước.
    this.authCache.invalidateKey(CACHE_PREFIX + row.familyId);
    return { userId: row.userId, pair };
  }

  /**
   * Dựng `AuthUser` cho mỗi request — `JwtAuthGuard` gọi hàm này.
   *
   * Đường nhanh (cache còn hạn) không chạm database. Đường chậm tra user + kiểm họ
   * refresh còn sống rồi nhớ lại 30 giây, nên đăng xuất/khoá tài khoản có hiệu lực trong
   * khoảng đó chứ không phải chờ hết TTL của access token.
   */
  async resolveAuthUser(rawToken: string): Promise<AuthUser | null> {
    const claims = this.verify(rawToken, ACCESS_TYPE);
    if (!claims) return null;

    const cacheKey = CACHE_PREFIX + claims.sid;
    const cached = this.authCache.get(cacheKey);
    if (cached) return cached;

    let userId: bigint;
    try {
      userId = BigInt(claims.sub);
    } catch {
      return null;
    }

    const [user, familyAlive] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId } }),
      this.isFamilyAlive(claims.sid),
    ]);
    if (!user || !user.active || user.status === 'inactive') return null;
    // Họ đã bị giết = đã đăng xuất (hoặc bị phát hiện lộ token). Access token còn hạn
    // nhưng không còn giá trị.
    if (!familyAlive) return null;

    const resolved = await this.rbac.resolvePermissions(user.id);
    const authUser: AuthUser = {
      userId: user.id,
      familyId: claims.sid,
      email: user.email,
      roles: user.roles,
      locationIds: resolved.locationIds,
      isAdmin: resolved.isAdmin,
      adminWarehouseIds: resolved.adminWarehouseIds,
      systemPermissions: resolved.systemPermissions,
      permissions: resolved.systemPermissions,
      warehousePermissions: resolved.warehousePermissions,
    };

    // Khoá cache là `familyId` chứ không phải userId: đăng xuất MỘT thiết bị phải không
    // đụng các thiết bị khác của cùng người. Chỉ mục theo userId trong AuthCacheService
    // lo phần ngược lại — đổi quyền thì quét sạch mọi phiên của người đó.
    this.authCache.set(cacheKey, user.id, authUser);
    return authUser;
  }

  /**
   * Giết cả họ: đăng xuất, hoặc phát hiện refresh token bị dùng lại. Trả số dòng thu hồi
   * được để chỗ gọi phân biệt "vừa đăng xuất thật" với "họ này đã chết từ trước".
   */
  async revokeFamily(familyId: string): Promise<number> {
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // Bỏ cache ngay để access token còn hạn chết cùng lúc, không đợi hết 30 giây TTL.
    this.authCache.invalidateKey(CACHE_PREFIX + familyId);
    return count;
  }

  /** Đọc `familyId` từ một refresh token thô mà KHÔNG cần nó còn hiệu lực (dùng cho logout). */
  familyOf(rawToken: string): string | null {
    return this.verify(rawToken, REFRESH_TYPE)?.sid ?? null;
  }

  private async issuePair(
    userId: bigint,
    familyId: string,
    ctx: SessionContext,
  ): Promise<TokenPair> {
    const now = Date.now();
    const accessExpiresAt = new Date(now + accessTtlMs());
    const refreshExpiresAt = new Date(now + refreshTtlMs());

    // `jti` để hai token phát trong cùng MỘT giây không ra chuỗi giống hệt nhau: mọi
    // claim còn lại đều trùng, kể cả `iat`/`exp` (đơn vị giây). Với refresh token đó là
    // yêu cầu cứng — `token_hash` là khoá duy nhất, trùng là lỗi ghi. Với access token
    // thì để mỗi lượt phát còn phân biệt được nhau trong log.
    const accessToken = this.jwt.sign(
      {
        sub: userId.toString(),
        sid: familyId,
        typ: ACCESS_TYPE,
        jti: randomUUID(),
      },
      { expiresIn: Math.floor(accessTtlMs() / 1000), issuer: JWT_ISSUER },
    );
    const refreshToken = this.jwt.sign(
      {
        sub: userId.toString(),
        sid: familyId,
        typ: REFRESH_TYPE,
        jti: randomUUID(),
      },
      { expiresIn: Math.floor(refreshTtlMs() / 1000), issuer: JWT_ISSUER },
    );

    await this.prisma.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: hash(refreshToken),
        userAgent: ctx.userAgent?.slice(0, 500) ?? null,
        ipAddress: ctx.ipAddress ?? null,
        expiresAt: refreshExpiresAt,
      },
    });

    return {
      accessToken,
      accessExpiresAt,
      refreshToken,
      refreshExpiresAt,
      familyId,
    };
  }

  /** Còn ít nhất một refresh token chưa thu hồi và chưa hết hạn. */
  private async isFamilyAlive(familyId: string): Promise<boolean> {
    const alive = await this.prisma.refreshToken.findFirst({
      where: { familyId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    return alive !== null;
  }

  /** Chữ ký sai, hết hạn, sai `iss`, hay nhầm loại token đều ra `null`. */
  private verify(rawToken: string, expectedType: string): TokenClaims | null {
    try {
      const claims = this.jwt.verify<TokenClaims>(rawToken, {
        issuer: JWT_ISSUER,
      });
      if (claims.typ !== expectedType) return null;
      if (!claims.sub || !claims.sid) return null;
      return claims;
    } catch {
      return null;
    }
  }

  /**
   * Token hết hạn không còn dùng được (đã kiểm ở `rotate`), nhưng để lại thì bảng phình
   * mãi — mỗi lần gia hạn đẻ thêm một dòng, nhiều hơn hẳn mô hình phiên cũ. Giữ thêm 30
   * ngày sau khi hết hạn để còn tra được lịch sử khi điều tra sự cố, rồi mới xoá.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanupExpired(): Promise<void> {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: cutoff } },
    });
    if (count > 0) this.logger.log(`Đã dọn ${count} refresh token hết hạn`);
  }
}
