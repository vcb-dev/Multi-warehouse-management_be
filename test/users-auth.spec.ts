/**
 * Metadata UsersController — GET /users yêu cầu staff:manage.
 */
import { PERMISSION_KEY } from '../src/common/decorators/permissions.decorator';
import { UsersController } from '../src/modules/rbac/users.controller';

describe('UsersController authorization metadata', () => {
  it('GET list yêu cầu staff:manage', () => {
    const perms = Reflect.getMetadata(
      PERMISSION_KEY,
      UsersController.prototype.list,
    ) as string[] | undefined;
    expect(perms).toContain('staff:manage');
  });

  it('GET assignable không yêu cầu staff:manage', () => {
    const perms = Reflect.getMetadata(
      PERMISSION_KEY,
      UsersController.prototype.listAssignable,
    ) as string[] | undefined;
    expect(perms).toBeUndefined();
  });

  it('GET :id yêu cầu staff:manage', () => {
    const perms = Reflect.getMetadata(
      PERMISSION_KEY,
      UsersController.prototype.findOne,
    ) as string[] | undefined;
    expect(perms).toContain('staff:manage');
  });
});
