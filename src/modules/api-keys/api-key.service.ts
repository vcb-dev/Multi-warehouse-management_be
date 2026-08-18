import { randomBytes, createHash } from 'crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ApiKey } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { RbacService } from '../rbac/rbac.service';
import { AuthCacheService } from '../rbac/auth-cache.service';
import { BusinessException } from '../../common/exceptions/business.exception';
import { CreateApiKeyDto } from './api-key.dto';

const KEY_PREFIX = 'whk_live_';

function hash(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

@Injectable()
export class ApiKeyService {
  constructor(
    private prisma: PrismaService,
    private rbac: RbacService,
    private authCache: AuthCacheService,
  ) {}

  /**
   * Tạo key mới, xác thực THAY `acting_user_id` — quyền của key = quyền thật của user đó
   * (đọc qua RbacService, y hệt JWT). Raw key chỉ được trả về đúng lần gọi này.
   */
  async create(dto: CreateApiKeyDto, createdBy: AuthUser) {
    const actingUser = await this.prisma.user.findUnique({
      where: { id: BigInt(dto.acting_user_id) },
    });
    if (!actingUser) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'acting_user_id không tồn tại',
        422,
      );
    }

    const rawKey = KEY_PREFIX + randomBytes(32).toString('base64url');
    const created = await this.prisma.apiKey.create({
      data: {
        name: dto.name,
        keyPrefix: rawKey.slice(0, 12),
        keyHash: hash(rawKey),
        actingUserId: actingUser.id,
        expiresAt: dto.expires_at ? new Date(dto.expires_at) : null,
        createdById: createdBy.userId,
      },
      include: { actingUser: true },
    });
    return { ...this.toDto(created), api_key: rawKey };
  }

  async list() {
    const rows = await this.prisma.apiKey.findMany({
      orderBy: { createdAt: 'desc' },
      include: { actingUser: true },
    });
    return { data: rows.map((r) => this.toDto(r)) };
  }

  async revoke(id: string) {
    const key = await this.prisma.apiKey.findUnique({
      where: { id: BigInt(id) },
    });
    if (!key) throw new NotFoundException('Không tìm thấy API key');
    await this.prisma.apiKey.update({
      where: { id: key.id },
      data: { isActive: false, revokedAt: new Date() },
    });
    // Key có thể đang dùng chung cache quyền (theo acting_user_id) với JWT thật của user
    // đó — xoá cache để không có AuthUser cũ nào còn sống sót sau khi thu hồi.
    this.authCache.invalidateUser(key.actingUserId);
    return { data: { id, revoked: true } };
  }

  /**
   * Dùng bởi `JwtAuthGuard` khi request mang header `x-api-key` thay vì `Authorization`.
   * Trả `null` khi key sai/không tồn tại/hết hạn/bị thu hồi/acting user không còn active —
   * guard tự quyết định mã lỗi, hàm này không throw.
   */
  async resolveAuthUser(rawKey: string): Promise<AuthUser | null> {
    const key = await this.prisma.apiKey.findUnique({
      where: { keyHash: hash(rawKey) },
    });
    if (!key) return null;
    if (!key.isActive || key.revokedAt) return null;
    if (key.expiresAt && key.expiresAt.getTime() < Date.now()) return null;

    // Không cần chờ — cập nhật lastUsedAt không ảnh hưởng kết quả xác thực.
    void this.prisma.apiKey
      .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    const cacheKey = key.actingUserId.toString();
    const cached = this.authCache.get(cacheKey);
    if (cached) return cached;

    const actingUser = await this.prisma.user.findUnique({
      where: { id: key.actingUserId },
    });
    if (!actingUser || !actingUser.active || actingUser.status === 'inactive') {
      return null;
    }

    const resolved = await this.rbac.resolvePermissions(actingUser.id);
    const authUser: AuthUser = {
      userId: actingUser.id,
      email: actingUser.email,
      roles: actingUser.roles,
      locationIds: resolved.locationIds,
      isAdmin: resolved.isAdmin,
      adminWarehouseIds: resolved.adminWarehouseIds,
      systemPermissions: resolved.systemPermissions,
      permissions: resolved.systemPermissions,
      warehousePermissions: resolved.warehousePermissions,
    };
    this.authCache.set(cacheKey, actingUser.id, authUser);
    return authUser;
  }

  private toDto(key: ApiKey & { actingUser: { email: string } }) {
    return {
      id: key.id.toString(),
      name: key.name,
      key_prefix: key.keyPrefix,
      acting_user_id: key.actingUserId.toString(),
      acting_user_email: key.actingUser.email,
      is_active: key.isActive,
      expires_at: key.expiresAt?.toISOString() ?? null,
      last_used_at: key.lastUsedAt?.toISOString() ?? null,
      created_at: key.createdAt.toISOString(),
      revoked_at: key.revokedAt?.toISOString() ?? null,
    };
  }
}
