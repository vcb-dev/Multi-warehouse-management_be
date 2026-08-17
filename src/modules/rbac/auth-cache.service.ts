import { Injectable } from '@nestjs/common';
import { AuthUser } from '../../common/decorators/current-user.decorator';

/**
 * Cache quyền đã resolve theo userId — dùng chung giữa `JwtStrategy` (đọc) và
 * các service RBAC (ghi, để invalidate ngay khi đổi quyền). Tách khỏi
 * JwtStrategy vì strategy không nhìn thấy được các thao tác ghi quyền.
 *
 * TTL ngắn (30s) đã đủ an toàn cho hầu hết trường hợp, nhưng "khoá tài khoản
 * / đổi role có hiệu lực ngay" là yêu cầu nghiệp vụ rõ ràng — invalidate chủ
 * động mới đảm bảo được điều đó thay vì chờ hết TTL.
 */
const TTL_MS = 30_000;
/** Quy mô ~135 user (research.md §4) — giới hạn rộng rãi để chặn phình vô hạn. */
const MAX_ENTRIES = 2000;

@Injectable()
export class AuthCacheService {
  private readonly cache = new Map<
    string,
    { value: AuthUser; expiresAt: number }
  >();

  get(userId: string): AuthUser | undefined {
    const cached = this.cache.get(userId);
    if (!cached) return undefined;
    if (cached.expiresAt <= Date.now()) {
      this.cache.delete(userId);
      return undefined;
    }
    return cached.value;
  }

  set(userId: string, value: AuthUser): void {
    this.evictIfFull();
    this.cache.set(userId, { value, expiresAt: Date.now() + TTL_MS });
  }

  invalidate(userId: string | bigint): void {
    this.cache.delete(userId.toString());
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  private evictIfFull(): void {
    if (this.cache.size < MAX_ENTRIES) return;
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
    // Toàn entry còn hạn (hiếm ở quy mô này) — nhường chỗ bằng cách bỏ entry
    // cũ nhất theo thứ tự chèn của Map, tự nó tự cân bằng lại theo thời gian.
    if (this.cache.size >= MAX_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
  }
}
