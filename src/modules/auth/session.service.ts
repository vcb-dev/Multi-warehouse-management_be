import { createHash, randomBytes } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';
import { AuthCacheService } from '../rbac/auth-cache.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';

/**
 * Tiền tố để nhận ra token của hệ thống này khi nó lọt vào log hay báo lỗi — và để
 * phân biệt với `whk_live_` của API key đối tác.
 */
const TOKEN_PREFIX = 'ses_';

/** Khớp maxAge của cookie NextAuth phía frontend. Lệch là FE tưởng còn phiên trong khi BE đã hết. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Ghi `lastSeenAt` thưa tay: cột này chỉ để hiển thị "hoạt động gần đây" trong màn quản
 * lý thiết bị, không tham gia quyết định xác thực. Ghi mỗi request là thêm một lượt UPDATE
 * vào đường nóng để đổi lấy độ chính xác không ai cần.
 */
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

export type SessionContext = {
  userAgent?: string;
  ipAddress?: string;
};

function hash(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Phiên đăng nhập lưu ở server.
 *
 * Token phát cho client là chuỗi ngẫu nhiên KHÔNG mang thông tin (opaque) — nó không tự
 * chứng minh được gì, chỉ hợp lệ khi đối chiếu ra một dòng còn sống trong `user_sessions`.
 * Đó là toàn bộ khác biệt so với JWT, và là thứ mua được ba điều:
 *
 *   1. Thu hồi từng phiên — đánh dấu một dòng là token chết ngay lập tức.
 *   2. Liệt kê được thiết bị nào đang đăng nhập.
 *   3. Không còn khoá ký nào để dò ngược offline: không có gì để crack từ một token
 *      bắt được, vì token không phải chữ ký của cái gì cả.
 *
 * Đổi lại là một lượt tra bảng mỗi request — nhưng lượt đó vốn đã tồn tại để kiểm
 * `active`/`status`, nên thực tế không thêm chi phí.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private prisma: PrismaService,
    private rbac: RbacService,
    private authCache: AuthCacheService,
  ) {}

  /**
   * Phát phiên mới. Token thô chỉ tồn tại ở giá trị trả về của hàm này — database chỉ
   * giữ SHA-256, nên rò database không kéo theo mạo danh được ai.
   */
  async create(
    userId: bigint,
    ctx: SessionContext = {},
  ): Promise<{ token: string; sessionId: bigint; expiresAt: Date }> {
    const rawToken = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    const session = await this.prisma.userSession.create({
      data: {
        userId,
        tokenHash: hash(rawToken),
        userAgent: ctx.userAgent?.slice(0, 500) ?? null,
        ipAddress: ctx.ipAddress ?? null,
        expiresAt,
      },
    });

    return { token: rawToken, sessionId: session.id, expiresAt };
  }

  /**
   * Dùng bởi `JwtAuthGuard` cho mỗi request mang `Authorization: Bearer`.
   *
   * Trả `null` cho mọi lý do từ chối (token sai, phiên đã thu hồi/hết hạn, tài khoản bị
   * khoá) — guard tự quyết mã lỗi, hàm này không throw. Cố ý không phân biệt lý do: nói
   * rõ "token đúng nhưng phiên đã thu hồi" là xác nhận giúp kẻ tấn công rằng token họ
   * nhặt được từng là thật.
   */
  async resolveAuthUser(rawToken: string): Promise<AuthUser | null> {
    const tokenHash = hash(rawToken);

    const cached = this.authCache.get(tokenHash);
    if (cached) return cached;

    const session = await this.prisma.userSession.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!session) return null;
    if (session.revokedAt) return null;
    if (session.expiresAt.getTime() <= Date.now()) return null;

    const { user } = session;
    if (!user.active || user.status === 'inactive') return null;

    this.touch(session.id, session.lastSeenAt);

    const resolved = await this.rbac.resolvePermissions(user.id);
    const authUser: AuthUser = {
      userId: user.id,
      sessionId: session.id,
      email: user.email,
      roles: user.roles,
      locationIds: resolved.locationIds,
      isAdmin: resolved.isAdmin,
      adminWarehouseIds: resolved.adminWarehouseIds,
      systemPermissions: resolved.systemPermissions,
      permissions: resolved.systemPermissions,
      warehousePermissions: resolved.warehousePermissions,
    };

    // Khoá cache là hash của token chứ không phải userId: thu hồi MỘT phiên phải không
    // đụng tới các phiên khác của cùng người. Chỉ mục theo userId trong AuthCacheService
    // lo phần ngược lại — đổi quyền thì quét sạch mọi phiên của người đó.
    this.authCache.set(tokenHash, user.id, authUser);
    return authUser;
  }

  /** Thu hồi đúng một phiên — nút "đăng xuất" và nút "đăng xuất thiết bị này". */
  async revoke(sessionId: bigint, userId: bigint): Promise<boolean> {
    const session = await this.prisma.userSession.findFirst({
      where: { id: sessionId, userId, revokedAt: null },
    });
    if (!session) return false;

    await this.prisma.userSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
    this.authCache.invalidateKey(session.tokenHash);
    return true;
  }

  /**
   * Thu hồi mọi phiên của một người. `exceptSessionId` để phục vụ "đăng xuất các thiết
   * bị khác" — giữ lại đúng phiên đang thao tác.
   */
  async revokeAll(userId: bigint, exceptSessionId?: bigint): Promise<number> {
    const { count } = await this.prisma.userSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      data: { revokedAt: new Date() },
    });
    this.authCache.invalidateUser(userId);
    return count;
  }

  /** Thiết bị đang đăng nhập, mới nhất trước. */
  async list(userId: bigint, currentSessionId?: bigint) {
    const rows = await this.prisma.userSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
    });
    return {
      data: rows.map((r) => ({
        id: r.id.toString(),
        user_agent: r.userAgent,
        ip_address: r.ipAddress,
        created_at: r.createdAt.toISOString(),
        last_seen_at: r.lastSeenAt.toISOString(),
        expires_at: r.expiresAt.toISOString(),
        // Để UI đánh dấu "thiết bị này" và không cho tự đá mình một cách bất ngờ.
        is_current: currentSessionId ? r.id === currentSessionId : false,
      })),
    };
  }

  /**
   * Không chờ và nuốt lỗi: `lastSeenAt` chỉ để hiển thị, hỏng thì cũng không được phép
   * làm hỏng request đang phục vụ.
   */
  private touch(sessionId: bigint, lastSeenAt: Date): void {
    if (Date.now() - lastSeenAt.getTime() < LAST_SEEN_THROTTLE_MS) return;
    void this.prisma.userSession
      .update({ where: { id: sessionId }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
  }

  /**
   * Phiên hết hạn không còn dùng được (đã kiểm ở `resolveAuthUser`), nhưng để lại thì
   * bảng phình mãi. Giữ thêm 30 ngày sau khi hết hạn để còn tra được lịch sử đăng nhập
   * khi điều tra sự cố, rồi mới xoá.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanupExpired(): Promise<void> {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.userSession.deleteMany({
      where: { expiresAt: { lt: cutoff } },
    });
    if (count > 0) this.logger.log(`Đã dọn ${count} phiên hết hạn`);
  }
}
