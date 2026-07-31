/**
 * AuthCacheService — cache quyền dùng chung giữa JwtStrategy (đọc) và các
 * service RBAC (ghi, để invalidate ngay khi đổi quyền/khoá tài khoản). Đây là
 * cơ chế duy nhất khiến "khoá tài khoản có hiệu lực ngay" là sự thật thay vì
 * chờ hết TTL 30s. Xem docs/03-tech/ke-hoach-sua-phan-quyen.md — Phase 6.
 */
import { AuthCacheService } from '../src/modules/rbac/auth-cache.service';
import type { AuthUser } from '../src/common/decorators/current-user.decorator';

const user = (userId: bigint): AuthUser => ({
  userId,
  email: `u${userId}@test`,
  roles: [],
  locationIds: [],
});

describe('AuthCacheService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('trả undefined khi chưa set', () => {
    expect(new AuthCacheService().get('1')).toBeUndefined();
  });

  it('trả đúng giá trị vừa set', () => {
    const cache = new AuthCacheService();
    cache.set('1', user(1n));
    expect(cache.get('1')).toEqual(user(1n));
  });

  it('hết hạn sau TTL 30s', () => {
    jest.useFakeTimers({ now: 0 });
    const cache = new AuthCacheService();
    cache.set('1', user(1n));
    jest.setSystemTime(29_999);
    expect(cache.get('1')).toBeDefined();
    jest.setSystemTime(30_001);
    expect(cache.get('1')).toBeUndefined();
  });

  it('invalidate xoá ngay — không cần chờ hết TTL', () => {
    const cache = new AuthCacheService();
    cache.set('1', user(1n));
    cache.invalidate('1');
    expect(cache.get('1')).toBeUndefined();
  });

  it('invalidate nhận cả bigint lẫn string, cùng trỏ một entry', () => {
    const cache = new AuthCacheService();
    cache.set('1', user(1n));
    cache.invalidate(1n);
    expect(cache.get('1')).toBeUndefined();
  });

  it('invalidate userId không tồn tại thì không throw', () => {
    const cache = new AuthCacheService();
    expect(() => cache.invalidate('999')).not.toThrow();
  });

  it('invalidateAll xoá sạch mọi user', () => {
    const cache = new AuthCacheService();
    cache.set('1', user(1n));
    cache.set('2', user(2n));
    cache.invalidateAll();
    expect(cache.get('1')).toBeUndefined();
    expect(cache.get('2')).toBeUndefined();
  });

  it('không phình vô hạn — vượt MAX_ENTRIES thì tự dọn bớt', () => {
    const cache = new AuthCacheService();
    for (let i = 0; i < 2100; i++) {
      cache.set(String(i), user(BigInt(i)));
    }
    // Riêng test dựng ~2100 entry hợp lệ (chưa hết TTL) nên phần dọn "hết hạn"
    // không có gì để xoá — buộc phải trục xuất entry cũ nhất mới hạ được size.
    expect(cache.get('0')).toBeUndefined();
    // Entry gần nhất phải còn sống — không phải cache tự xoá sạch bừa bãi.
    expect(cache.get('2099')).toBeDefined();
  });
});
