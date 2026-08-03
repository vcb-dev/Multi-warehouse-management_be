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

  it('GET assignable chỉ cần dashboard:view — không chặn nhân viên thường', () => {
    // Dropdown gán đơn dùng ở nhiều module (đơn hàng, nhập hàng, NCC); mọi role
    // seed đều có dashboard:view nên đây gần như "đã đăng nhập" chứ không phải
    // staff:manage (finding #9: endpoint này từng không gắn quyền gì).
    const perms = Reflect.getMetadata(
      PERMISSION_KEY,
      UsersController.prototype.listAssignable,
    ) as string[] | undefined;
    expect(perms).toEqual(['dashboard:view']);
    expect(perms).not.toContain('staff:manage');
  });

  it('GET :id yêu cầu staff:manage', () => {
    const perms = Reflect.getMetadata(
      PERMISSION_KEY,
      UsersController.prototype.findOne,
    ) as string[] | undefined;
    expect(perms).toContain('staff:manage');
  });
});
