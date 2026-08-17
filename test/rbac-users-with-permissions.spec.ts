/**
 * Unit test RbacService.usersWithPermissions — chiều NGƯỢC của resolvePermissions
 * (test ở rbac-resolver.spec.ts). Đây là chốt chặn thật của fan-out thông báo: sai một
 * ly ở đây là gửi thông báo cho người không có quyền xem, hoặc bỏ sót người phải nhận.
 */
import { PermissionScope } from '@prisma/client';
import { RbacService } from '../src/modules/rbac/rbac.service';
import type { PrismaService } from '../src/prisma/prisma.service';

function fakePrisma(
  assignments: unknown[],
  overrides: unknown[] = [],
): PrismaService {
  return {
    userLocationRole: {
      findMany: jest.fn().mockResolvedValue(assignments),
    },
    userPermissionOverride: {
      findMany: jest.fn().mockResolvedValue(overrides),
    },
  } as unknown as PrismaService;
}

const perm = (
  key: string,
  scope: PermissionScope = PermissionScope.location,
) => ({ permission: { key, scope } });

const assignment = (opts: {
  userId: bigint;
  locationId: bigint;
  isSystem?: boolean;
  code?: string;
  permissions: ReturnType<typeof perm>[];
}) => ({
  userId: opts.userId,
  locationId: opts.locationId,
  role: {
    isSystem: opts.isSystem ?? false,
    code: opts.code ?? 'sales',
    permissions: opts.permissions,
  },
});

describe('RbacService.usersWithPermissions', () => {
  it('quyền scope=location chỉ khớp user có role ĐÚNG kho đang xét', async () => {
    const prisma = fakePrisma([
      assignment({ userId: 1n, locationId: 1n, permissions: [perm('order:view')] }),
      assignment({ userId: 2n, locationId: 2n, permissions: [perm('order:view')] }),
    ]);
    const res = await new RbacService(prisma).usersWithPermissions(
      ['order:view'],
      1n,
    );
    expect(res).toEqual([1n]);
  });

  it('quyền scope=system khớp bất kể role gán ở kho nào', async () => {
    const prisma = fakePrisma([
      assignment({
        userId: 1n,
        locationId: 5n, // gán ở kho 5, nhưng report:view là system nên không quan trọng
        permissions: [perm('report:view', PermissionScope.system)],
      }),
    ]);
    const res = await new RbacService(prisma).usersWithPermissions(
      ['report:view'],
      1n, // đang hỏi cho kho 1 — khác hẳn kho user được gán
    );
    expect(res).toEqual([1n]);
  });

  it('locationId=null (sự kiện không thuộc kho nào) → quyền location khớp ở BẤT KỲ kho nào user có', async () => {
    const prisma = fakePrisma([
      assignment({ userId: 1n, locationId: 3n, permissions: [perm('customer:view')] }),
    ]);
    const res = await new RbacService(prisma).usersWithPermissions(
      ['customer:view'],
      null,
    );
    expect(res).toEqual([1n]);
  });

  it('role admin bỏ qua mọi kiểm tra quyền — luôn khớp bất kể keys yêu cầu là gì', async () => {
    const prisma = fakePrisma([
      assignment({
        userId: 9n,
        locationId: 1n,
        isSystem: true,
        code: 'admin',
        permissions: [], // cố tình để trống — admin không cần liệt kê permission cụ thể
      }),
    ]);
    const res = await new RbacService(prisma).usersWithPermissions(
      ['order:view', 'inventory:view', 'bat_ky_quyen_nao'],
      1n,
    );
    expect(res).toEqual([9n]);
  });

  it('yêu cầu NHIỀU permission → user phải có ĐỦ, thiếu một là loại', async () => {
    const prisma = fakePrisma([
      assignment({
        userId: 1n,
        locationId: 1n,
        permissions: [perm('order:view')], // thiếu order:pack
      }),
      assignment({
        userId: 2n,
        locationId: 1n,
        permissions: [perm('order:view'), perm('order:pack')],
      }),
    ]);
    const res = await new RbacService(prisma).usersWithPermissions(
      ['order:view', 'order:pack'],
      1n,
    );
    expect(res).toEqual([2n]);
  });

  it('override GRANTED thêm quyền không có sẵn từ role', async () => {
    const prisma = fakePrisma(
      [assignment({ userId: 1n, locationId: 1n, permissions: [] })],
      [
        {
          userId: 1n,
          locationId: 1n,
          granted: true,
          permission: { key: 'order:cancel', scope: PermissionScope.location },
        },
      ],
    );
    const res = await new RbacService(prisma).usersWithPermissions(
      ['order:cancel'],
      1n,
    );
    expect(res).toEqual([1n]);
  });

  it('override REVOKED rút quyền dù role đã cấp — user KHÔNG được nhận nữa', async () => {
    const prisma = fakePrisma(
      [assignment({ userId: 1n, locationId: 1n, permissions: [perm('order:view')] })],
      [
        {
          userId: 1n,
          locationId: 1n,
          granted: false,
          permission: { key: 'order:view', scope: PermissionScope.location },
        },
      ],
    );
    const res = await new RbacService(prisma).usersWithPermissions(
      ['order:view'],
      1n,
    );
    expect(res).toEqual([]);
  });

  it('override ở KHO KHÁC với sự kiện thì không áp dụng', async () => {
    const prisma = fakePrisma(
      [assignment({ userId: 1n, locationId: 1n, permissions: [perm('order:view')] })],
      [
        {
          userId: 1n,
          locationId: 2n, // override khai ở kho 2, sự kiện ở kho 1
          granted: false,
          permission: { key: 'order:view', scope: PermissionScope.location },
        },
      ],
    );
    const res = await new RbacService(prisma).usersWithPermissions(
      ['order:view'],
      1n,
    );
    // Override kho 2 không đụng tới quyền tại kho 1 — vẫn giữ nguyên từ role.
    expect(res).toEqual([1n]);
  });

  it('override scope=system bị bỏ qua — giống hệt logic của resolvePermissions', async () => {
    const prisma = fakePrisma(
      [assignment({ userId: 1n, locationId: 1n, permissions: [] })],
      [
        {
          userId: 1n,
          locationId: 1n,
          granted: true,
          permission: { key: 'report:view', scope: PermissionScope.system },
        },
      ],
    );
    const res = await new RbacService(prisma).usersWithPermissions(
      ['report:view'],
      1n,
    );
    // Override system không có tác dụng ⇒ user không có report:view thật sự.
    expect(res).toEqual([]);
  });

  it('không có assignment nào khớp → mảng rỗng, không throw', async () => {
    const prisma = fakePrisma([]);
    const res = await new RbacService(prisma).usersWithPermissions(
      ['order:view'],
      1n,
    );
    expect(res).toEqual([]);
  });

  it('keys rỗng ([]) → mọi user có assignment đều khớp (every() trên mảng rỗng luôn true)', async () => {
    const prisma = fakePrisma([
      assignment({ userId: 1n, locationId: 1n, permissions: [] }),
    ]);
    const res = await new RbacService(prisma).usersWithPermissions([], 1n);
    expect(res).toEqual([1n]);
  });

  it('không trùng lặp id khi user có nhiều assignment cùng khớp điều kiện', async () => {
    const prisma = fakePrisma([
      assignment({ userId: 1n, locationId: 1n, permissions: [perm('order:view')] }),
      assignment({ userId: 1n, locationId: 1n, permissions: [perm('order:pack')] }),
    ]);
    const res = await new RbacService(prisma).usersWithPermissions(
      ['order:view'],
      1n,
    );
    expect(res).toEqual([1n]);
  });
});
