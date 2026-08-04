import { randomBytes, createHash } from 'crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ApiKey } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { CreateApiKeyDto } from './api-key.dto';

const KEY_PREFIX = 'whk_live_';

function hash(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

@Injectable()
export class ApiKeyService {
  constructor(private prisma: PrismaService) {}

  /** Tạo key mới. Raw key chỉ được trả về đúng lần gọi này — DB chỉ giữ hash. */
  async create(dto: CreateApiKeyDto, user: AuthUser) {
    const rawKey = KEY_PREFIX + randomBytes(32).toString('base64url');
    const created = await this.prisma.apiKey.create({
      data: {
        name: dto.name,
        keyPrefix: rawKey.slice(0, 12),
        keyHash: hash(rawKey),
        scopes: dto.scopes,
        locationIds: (dto.location_ids ?? []).map((id) => BigInt(id)),
        expiresAt: dto.expires_at ? new Date(dto.expires_at) : null,
        createdById: user.userId,
      },
    });
    return { ...this.toDto(created), api_key: rawKey };
  }

  async list() {
    const rows = await this.prisma.apiKey.findMany({
      orderBy: { createdAt: 'desc' },
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
    return { data: { id, revoked: true } };
  }

  /**
   * Dùng bởi `ApiKeyGuard`. Trả `null` khi key sai/không tồn tại/hết hạn/bị thu hồi —
   * guard tự quyết định mã lỗi trả về, service này không throw.
   */
  async validate(rawKey: string): Promise<ApiKey | null> {
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

    return key;
  }

  private toDto(key: ApiKey) {
    return {
      id: key.id.toString(),
      name: key.name,
      key_prefix: key.keyPrefix,
      scopes: key.scopes,
      location_ids: key.locationIds.map((id) => id.toString()),
      is_active: key.isActive,
      expires_at: key.expiresAt?.toISOString() ?? null,
      last_used_at: key.lastUsedAt?.toISOString() ?? null,
      created_at: key.createdAt.toISOString(),
      revoked_at: key.revokedAt?.toISOString() ?? null,
    };
  }
}
