import { Injectable } from '@nestjs/common';
import { AuthUser } from '../../common/decorators/current-user.decorator';

const TTL_MS = 30_000;

/** Quy mô hiện tại dưới 200 tài khoản, mỗi người vài thiết bị — giới hạn rộng rãi để chặn phình vô hạn. */
const MAX_ENTRIES = 2000;

@Injectable()
export class AuthCacheService {
  private readonly cache = new Map<
    string,
    { value: AuthUser; expiresAt: number; userId: string }
  >();

  /** userId -> các khoá cache đang giữ phiên của người đó. */
  private readonly byUser = new Map<string, Set<string>>();

  get(key: string): AuthUser | undefined {
    const cached = this.cache.get(key);
    if (!cached) return undefined;
    if (cached.expiresAt <= Date.now()) {
      this.drop(key);
      return undefined;
    }
    return cached.value;
  }

  set(key: string, userId: string | bigint, value: AuthUser): void {
    this.evictIfFull();
    const uid = userId.toString();
    this.cache.set(key, { value, expiresAt: Date.now() + TTL_MS, userId: uid });
    const keys = this.byUser.get(uid) ?? new Set<string>();
    keys.add(key);
    this.byUser.set(uid, keys);
  }

  /** Thu hồi một phiên / một API key. Các phiên khác của cùng người vẫn sống. */
  invalidateKey(key: string): void {
    this.drop(key);
  }

  /** Đổi quyền, đổi role, khoá tài khoản — mọi phiên của người này phải resolve lại. */
  invalidateUser(userId: string | bigint): void {
    const uid = userId.toString();
    const keys = this.byUser.get(uid);
    if (!keys) return;
    for (const key of keys) this.cache.delete(key);
    this.byUser.delete(uid);
  }

  invalidateAll(): void {
    this.cache.clear();
    this.byUser.clear();
  }

  private drop(key: string): void {
    const entry = this.cache.get(key);
    this.cache.delete(key);
    if (!entry) return;
    const keys = this.byUser.get(entry.userId);
    if (!keys) return;
    keys.delete(key);
    if (keys.size === 0) this.byUser.delete(entry.userId);
  }

  private evictIfFull(): void {
    if (this.cache.size < MAX_ENTRIES) return;
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.drop(key);
    }
    // Toàn entry còn hạn (hiếm ở quy mô này) — nhường chỗ bằng cách bỏ entry cũ nhất
    // theo thứ tự chèn của Map, tự nó tự cân bằng lại theo thời gian.
    if (this.cache.size >= MAX_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.drop(oldestKey);
    }
  }
}
