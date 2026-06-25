/**
 * Unit test warehouse scope helpers.
 */
import { ForbiddenException } from '@nestjs/common';
import { assertAnyWarehouseAccess } from '../src/common/auth/access';
import type { AuthUser } from '../src/common/decorators/current-user.decorator';

const user: AuthUser = {
  userId: 1n,
  email: 'u@test',
  roles: [],
  warehouseIds: [10n, 20n],
  isAdmin: false,
};

describe('assertAnyWarehouseAccess', () => {
  it('pass khi ít nhất một kho trùng', () => {
    expect(() => assertAnyWarehouseAccess(user, [99n, 20n])).not.toThrow();
  });

  it('FORBIDDEN_SCOPE khi không có kho trùng', () => {
    expect(() => assertAnyWarehouseAccess(user, [99n, 88n])).toThrow(
      ForbiddenException,
    );
  });

  it('admin bypass', () => {
    const admin: AuthUser = { ...user, isAdmin: true };
    expect(() => assertAnyWarehouseAccess(admin, [999n])).not.toThrow();
  });
});
