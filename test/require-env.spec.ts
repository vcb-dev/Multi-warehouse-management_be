/**
 * Secret bắt buộc phải đến từ env — không có giá trị mặc định trong repo.
 */
import type { ConfigService } from '@nestjs/config';
import { requireEnv } from '../src/common/utils/require-env';
import { JwtStrategy } from '../src/modules/auth/jwt.strategy';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { RbacService } from '../src/modules/rbac/rbac.service';
import type { AuthCacheService } from '../src/modules/rbac/auth-cache.service';

const configWith = (values: Record<string, string | undefined>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

describe('requireEnv', () => {
  it('trả về giá trị khi env có', () => {
    expect(requireEnv(configWith({ JWT_SECRET: 's3cret' }), 'JWT_SECRET')).toBe(
      's3cret',
    );
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
});

describe('JwtStrategy', () => {
  const deps = [
    {} as PrismaService,
    {} as RbacService,
    {} as AuthCacheService,
  ] as const;

  it('khởi tạo được khi có JWT_SECRET', () => {
    expect(
      () => new JwtStrategy(configWith({ JWT_SECRET: 's3cret' }), ...deps),
    ).not.toThrow();
  });

  it('chết ngay lúc khởi tạo khi thiếu JWT_SECRET', () => {
    expect(() => new JwtStrategy(configWith({}), ...deps)).toThrow(
      /JWT_SECRET/,
    );
  });
});
