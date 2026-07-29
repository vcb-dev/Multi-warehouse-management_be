/**
 * Unit test warehouse scope helpers.
 */
import { ForbiddenException } from '@nestjs/common';
import { assertAnyLocationAccess } from '../src/common/auth/access';
import type { AuthUser } from '../src/common/decorators/current-user.decorator';

const user: AuthUser = {
  userId: 1n,
  email: 'u@test',
  roles: [],
  locationIds: [10n, 20n],
  isAdmin: false,
};

describe('assertAnyLocationAccess', () => {
  it('pass khi ít nhất một kho trùng', () => {
    expect(() => assertAnyLocationAccess(user, [99n, 20n])).not.toThrow();
  });

  it('FORBIDDEN_SCOPE khi không có kho trùng', () => {
    expect(() => assertAnyLocationAccess(user, [99n, 88n])).toThrow(
      ForbiddenException,
    );
  });

  it('admin flag không bypass nếu không admin tại kho đích', () => {
    const admin: AuthUser = { ...user, isAdmin: true, adminWarehouseIds: [10n] };
    expect(() => assertAnyLocationAccess(admin, [999n])).toThrow(
      ForbiddenException,
    );
  });
});
