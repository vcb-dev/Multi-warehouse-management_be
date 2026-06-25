/**
 * US1 — E2E CRUD role, chặn xóa role hệ thống/đang dùng, gán role theo kho.
 * Chạy: RUN_INTEGRATION_TESTS=1 npm test -- test/roles.e2e-spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, ConflictException } from '@nestjs/common';
import { RbacModule } from '../src/modules/rbac/rbac.module';
import { RoleService } from '../src/modules/rbac/role.service';
import { UserAdminService } from '../src/modules/rbac/user-admin.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

describeIfDb('roles RBAC (integration)', () => {
  let roles: RoleService;
  let users: UserAdminService;
  let prisma: PrismaService;

  let targetUserId: string;
  let warehouseId: string;
  let salesRoleId: string;
  let customRoleId: string;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, RbacModule],
    }).compile();
    roles = module.get(RoleService);
    users = module.get(UserAdminService);
    prisma = module.get(PrismaService);

    const user = await prisma.user.findFirst({ where: { email: 'sales@local.dev' } });
    const warehouse = await prisma.warehouse.findFirst();
    const salesRole = await prisma.role.findUnique({ where: { code: 'sales' } });
    if (!user || !warehouse || !salesRole) {
      throw new Error('Run prisma db seed before integration tests');
    }
    targetUserId = user.id.toString();
    warehouseId = warehouse.id.toString();
    salesRoleId = salesRole.id.toString();
  });

  afterAll(async () => {
    if (customRoleId) {
      await prisma.userWarehouseRole.deleteMany({ where: { roleId: BigInt(customRoleId) } });
      await prisma.rolePermission.deleteMany({ where: { roleId: BigInt(customRoleId) } });
      await prisma.role.deleteMany({ where: { id: BigInt(customRoleId) } });
    }
    await prisma.$disconnect();
  });

  it('tạo role tùy chỉnh và cập nhật quyền', async () => {
    const created = await roles.create({
      name: 'Vai trò test',
      code: `test_role_${Date.now()}`,
      permission_keys: ['order:view', 'order:pack'],
    });
    customRoleId = created.data.id;
    expect(created.data.permissions).toEqual(
      expect.arrayContaining(['order:view', 'order:pack']),
    );

    const updated = await roles.update(customRoleId, {
      permission_keys: ['order:view'],
    });
    expect(updated.data.permissions).toEqual(['order:view']);
  });

  it('ROLE_SYSTEM khi xóa role hệ thống', async () => {
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'admin' } });
    await expect(roles.remove(adminRole.id.toString())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('ROLE_IN_USE khi xóa role đang được gán', async () => {
    await expect(roles.remove(salesRoleId)).rejects.toBeInstanceOf(ConflictException);
  });

  it('PUT warehouse-roles: gán 1 role/kho và chặn trùng warehouse', async () => {
    const result = await users.putWarehouseRoles(targetUserId, {
      assignments: [{ warehouse_id: warehouseId, role_id: salesRoleId }],
    });
    expect(result.data.warehouse_roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          warehouse_id: warehouseId,
          role_id: salesRoleId,
        }),
      ]),
    );

    await expect(
      users.putWarehouseRoles(targetUserId, {
        assignments: [
          { warehouse_id: warehouseId, role_id: salesRoleId },
          { warehouse_id: warehouseId, role_id: customRoleId },
        ],
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('DUPLICATE_WAREHOUSE') });
  });
});
