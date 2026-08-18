/**
 * Secret bắt buộc phải đến từ env — không có giá trị mặc định trong repo.
 *
 * Không chỉ kiểm "có đặt hay chưa": secret ngắn kiểu cụm từ dễ nhớ bị dò ngược
 * offline từ đúng MỘT token bắt được (HS256, hashcat -m 16500), mà dò ra là ký
 * được token cho bất kỳ user id nào. Nên độ dài và giá trị mẫu cũng phải chặn.
 */
import type { ConfigService } from '@nestjs/config';
import { requireEnv } from '../src/common/utils/require-env';
import { JwtStrategy } from '../src/modules/auth/jwt.strategy';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { RbacService } from '../src/modules/rbac/rbac.service';
import type { AuthCacheService } from '../src/modules/rbac/auth-cache.service';

const configWith = (values: Record<string, string | undefined>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

/** Dạng `openssl rand -base64 32` cho ra — 44 ký tự. */
const VALID_SECRET = 'K7pQ2mXvN8sT4wY6zB1cF3hJ5kL9nR0dG2jM4pS6tV8=';

describe('requireEnv', () => {
  it('trả về giá trị khi env có và đủ mạnh', () => {
    expect(
      requireEnv(configWith({ JWT_SECRET: VALID_SECRET }), 'JWT_SECRET'),
    ).toBe(VALID_SECRET);
  });

  it('throw khi thiếu env — không được rơi về secret mặc định', () => {
    expect(() => requireEnv(configWith({}), 'JWT_SECRET')).toThrow(
      /JWT_SECRET/,
    );
  });

  it('throw khi env rỗng hoặc chỉ có khoảng trắng', () => {
    expect(() =>
      requireEnv(configWith({ JWT_SECRET: '   ' }), 'JWT_SECRET'),
    ).toThrow(/JWT_SECRET/);
  });

  it('throw khi secret quá ngắn — đây là loại bị crack offline', () => {
    expect(() =>
      requireEnv(configWith({ JWT_SECRET: 's3cret' }), 'JWT_SECRET'),
    ).toThrow(/quá ngắn/);
  });

  it('throw khi vẫn là giá trị mẫu trong .env.example', () => {
    expect(() =>
      requireEnv(
        configWith({ JWT_SECRET: 'change-me-in-production' }),
        'JWT_SECRET',
      ),
    ).toThrow(/giá trị mẫu/);
  });

  it('biến không phải *_SECRET thì không bị áp luật độ dài', () => {
    // Quan trọng: secret của đối tác (độ dài do họ quyết) không đi qua luật này,
    // và các biến cấu hình thường như URL vẫn ngắn được.
    expect(requireEnv(configWith({ APP_URL: 'http://a' }), 'APP_URL')).toBe(
      'http://a',
    );
  });
});

describe('JwtStrategy', () => {
  const deps = [
    {} as PrismaService,
    {} as RbacService,
    {} as AuthCacheService,
  ] as const;

  it('khởi tạo được khi có JWT_SECRET hợp lệ', () => {
    expect(
      () => new JwtStrategy(configWith({ JWT_SECRET: VALID_SECRET }), ...deps),
    ).not.toThrow();
  });

  it('chết ngay lúc khởi tạo khi thiếu JWT_SECRET', () => {
    expect(() => new JwtStrategy(configWith({}), ...deps)).toThrow(
      /JWT_SECRET/,
    );
  });

  it('chết ngay lúc khởi tạo khi JWT_SECRET quá yếu', () => {
    expect(
      () => new JwtStrategy(configWith({ JWT_SECRET: 's3cret' }), ...deps),
    ).toThrow(/quá ngắn/);
  });
});
