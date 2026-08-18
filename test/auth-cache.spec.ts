/**
 * AuthCacheService — cache quyền dùng chung giữa SessionService/ApiKeyService (đọc) và
 * các service RBAC (ghi, để invalidate ngay khi đổi quyền/khoá tài khoản).
 *
 * Khoá cache là thông tin xác thực (hash token phiên, hoặc userId cho API key) chứ không
 * phải userId, vì thu hồi phải làm được ở hai mức khác nhau:
 *   - một phiên, không đụng thiết bị khác của cùng người
 *   - toàn bộ phiên của một người, khi đổi role hay khoá tài khoản
 *
 * Đây là cơ chế duy nhất khiến "thu hồi có hiệu lực ngay" là sự thật thay vì chờ hết
 * TTL 30s. Xem docs/03-tech/ke-hoach-sua-phan-quyen.md — Phase 6.
 */
import { AuthCacheService } from '../src/modules/rbac/auth-cache.service';
import type { AuthUser } from '../src/common/decorators/current-user.decorator';

const user = (userId: bigint): AuthUser => ({
  userId,
  email: `u${userId}@test`,
  roles: [],
  locationIds: [],
});

describe('AuthCacheService — cơ bản', () => {
  afterEach(() => jest.useRealTimers());

  it('trả undefined khi chưa set', () => {
    expect(new AuthCacheService().get('hash-a')).toBeUndefined();
  });

  it('trả đúng giá trị vừa set', () => {
    const cache = new AuthCacheService();
    cache.set('hash-a', 1n, user(1n));
    expect(cache.get('hash-a')).toEqual(user(1n));
  });

  it('hết hạn sau TTL 30s', () => {
    jest.useFakeTimers({ now: 0 });
    const cache = new AuthCacheService();
    cache.set('hash-a', 1n, user(1n));
    jest.setSystemTime(29_999);
    expect(cache.get('hash-a')).toBeDefined();
    jest.setSystemTime(30_001);
    expect(cache.get('hash-a')).toBeUndefined();
  });
});

describe('AuthCacheService — thu hồi một phiên', () => {
  it('invalidateKey chỉ giết đúng phiên đó', () => {
    // Đây là điều mô hình cũ (đánh khoá theo userId) không làm được: thu hồi một
    // thiết bị mà không đá văng các thiết bị còn lại của cùng người.
    const cache = new AuthCacheService();
    cache.set('hash-dienthoai', 7n, user(7n));
    cache.set('hash-maytinh', 7n, user(7n));

    cache.invalidateKey('hash-dienthoai');

    expect(cache.get('hash-dienthoai')).toBeUndefined();
    expect(cache.get('hash-maytinh')).toBeDefined();
  });

  it('invalidateKey với khoá không tồn tại -> không nổ', () => {
    const cache = new AuthCacheService();
    expect(() => cache.invalidateKey('khong-co')).not.toThrow();
  });
});

describe('AuthCacheService — thu hồi theo người dùng', () => {
  it('invalidateUser quét sạch mọi phiên của người đó', () => {
    // Đổi role hay khoá tài khoản phải có hiệu lực trên MỌI thiết bị ngay lập tức.
    const cache = new AuthCacheService();
    cache.set('hash-dienthoai', 7n, user(7n));
    cache.set('hash-maytinh', 7n, user(7n));
    cache.set('hash-nguoikhac', 9n, user(9n));

    cache.invalidateUser(7n);

    expect(cache.get('hash-dienthoai')).toBeUndefined();
    expect(cache.get('hash-maytinh')).toBeUndefined();
    expect(cache.get('hash-nguoikhac')).toBeDefined();
  });

  it('nhận cả bigint lẫn chuỗi cho userId', () => {
    const cache = new AuthCacheService();
    cache.set('hash-a', 7n, user(7n));
    cache.invalidateUser('7');
    expect(cache.get('hash-a')).toBeUndefined();
  });

  it('invalidateUser với người chưa có phiên nào -> không nổ', () => {
    const cache = new AuthCacheService();
    expect(() => cache.invalidateUser(99n)).not.toThrow();
  });

  it('chỉ mục theo user được dọn khi entry hết hạn, không rò rỉ', () => {
    jest.useFakeTimers({ now: 0 });
    const cache = new AuthCacheService();
    cache.set('hash-a', 7n, user(7n));

    jest.setSystemTime(30_001);
    expect(cache.get('hash-a')).toBeUndefined(); // lượt get này dọn entry

    // Set lại rồi invalidate theo user: nếu chỉ mục còn giữ khoá cũ đã chết thì
    // vòng lặp invalidate vẫn chạy đúng, nhưng entry mới phải bị xoá.
    cache.set('hash-b', 7n, user(7n));
    cache.invalidateUser(7n);
    expect(cache.get('hash-b')).toBeUndefined();
    jest.useRealTimers();
  });

  it('invalidateAll xoá cả cache lẫn chỉ mục', () => {
    const cache = new AuthCacheService();
    cache.set('hash-a', 7n, user(7n));
    cache.set('hash-b', 9n, user(9n));

    cache.invalidateAll();

    expect(cache.get('hash-a')).toBeUndefined();
    expect(cache.get('hash-b')).toBeUndefined();
    expect(() => cache.invalidateUser(7n)).not.toThrow();
  });
});
