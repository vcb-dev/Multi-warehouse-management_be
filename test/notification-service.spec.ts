/**
 * Unit test NotificationService — mock Prisma + RbacService, không đụng DB thật (khác
 * test/notification.e2e-spec.ts vốn chạy trên DB production). Trọng tâm 3 hợp đồng mà
 * chính code đã ghi rõ trong comment nhưng chưa có test nào khoá lại:
 *
 * 1. `emit()` KHÔNG BAO GIỜ throw, kể cả khi Prisma lỗi (thông báo hỏng không được
 *    làm hỏng nghiệp vụ gọi nó — vd tạo đơn hàng).
 * 2. Cache cấu hình 60s — tránh 1 query mỗi lần tạo đơn — và invalidate đúng lúc.
 * 3. `list()`/`markRead()` luôn khoá theo `userId` — đây là chốt chặn riêng tư duy nhất.
 */
import { NotificationTopic, PermissionScope } from '@prisma/client';
import type { AuthUser } from '../src/common/decorators/current-user.decorator';
import { BusinessException } from '../src/common/exceptions/business.exception';
import { NotificationService } from '../src/modules/notifications/notification.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { RbacService } from '../src/modules/rbac/rbac.service';

function makeSetting(overrides: Record<string, unknown> = {}) {
  return {
    id: 1n,
    topic: NotificationTopic.orders_create,
    appEnabled: true,
    emailEnabled: false,
    recipientPermissions: ['order:view'],
    createdOn: new Date(),
    modifiedOn: new Date(),
    ...overrides,
  };
}

function fakePrisma(overrides: Record<string, unknown> = {}) {
  return {
    notificationSetting: {
      findMany: jest.fn().mockResolvedValue([makeSetting()]),
      update: jest.fn().mockResolvedValue(makeSetting()),
    },
    notification: {
      create: jest.fn().mockResolvedValue({ id: 1n }),
    },
    notificationRecipient: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    permission: {
      findMany: jest.fn().mockResolvedValue([{ key: 'order:view' }]),
    },
    ...overrides,
  } as unknown as PrismaService;
}

function fakeRbac(userIds: bigint[] = [9n]): RbacService {
  return {
    usersWithPermissions: jest.fn().mockResolvedValue(userIds),
  } as unknown as RbacService;
}

const user = (userId: bigint): AuthUser => ({
  userId,
  email: 'u@local.dev',
  roles: [],
  locationIds: [],
});

const emitInput = {
  subjectType: 'order' as const,
  subjectId: 42n,
  locationId: 1n,
  title: 'Đơn hàng mới HK001',
};

describe('NotificationService.emit', () => {
  it('topic tắt (app_enabled=false) → không tạo notification, không gọi RBAC', async () => {
    const prisma = fakePrisma({
      notificationSetting: {
        findMany: jest
          .fn()
          .mockResolvedValue([makeSetting({ appEnabled: false })]),
      },
    });
    const rbac = fakeRbac();
    await new NotificationService(prisma, rbac).emit(
      NotificationTopic.orders_create,
      emitInput,
    );
    expect(rbac.usersWithPermissions).not.toHaveBeenCalled();
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('topic chưa được seed (không có trong cấu hình) → coi như tắt, KHÔNG mặc định bật', async () => {
    const prisma = fakePrisma({
      notificationSetting: { findMany: jest.fn().mockResolvedValue([]) },
    });
    const rbac = fakeRbac();
    await new NotificationService(prisma, rbac).emit(
      NotificationTopic.orders_create,
      emitInput,
    );
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('topic bật nhưng RBAC không tìm ra ai → không tạo dòng notification rác', async () => {
    const prisma = fakePrisma();
    const rbac = fakeRbac([]); // không ai có quyền tại kho này
    await new NotificationService(prisma, rbac).emit(
      NotificationTopic.orders_create,
      emitInput,
    );
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('topic bật + có người nhận → tạo notification với recipients khớp đúng userIds từ RBAC', async () => {
    const prisma = fakePrisma();
    const rbac = fakeRbac([9n, 10n]);
    await new NotificationService(prisma, rbac).emit(
      NotificationTopic.orders_create,
      { ...emitInput, payload: { code: 'HK001' } },
    );

    expect(rbac.usersWithPermissions).toHaveBeenCalledWith(
      ['order:view'], // recipientPermissions của setting
      1n, // locationId từ input
    );
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        topic: NotificationTopic.orders_create,
        subjectType: 'order',
        subjectId: 42n,
        locationId: 1n,
        title: 'Đơn hàng mới HK001',
        payload: { code: 'HK001' },
        recipients: {
          createMany: {
            data: [{ userId: 9n }, { userId: 10n }],
            skipDuplicates: true,
          },
        },
      }),
    });
  });

  it('Prisma ném lỗi khi tạo → emit() KHÔNG throw ra ngoài (nuốt lỗi có chủ đích)', async () => {
    const prisma = fakePrisma({
      notification: {
        create: jest.fn().mockRejectedValue(new Error('DB sập')),
      },
    });
    const rbac = fakeRbac([9n]);
    await expect(
      new NotificationService(prisma, rbac).emit(
        NotificationTopic.orders_create,
        emitInput,
      ),
    ).resolves.toBeUndefined();
  });

  it('RBAC ném lỗi → emit() vẫn KHÔNG throw (toàn bộ try/catch bọc cả bước fan-out)', async () => {
    const prisma = fakePrisma();
    const rbac = {
      usersWithPermissions: jest.fn().mockRejectedValue(new Error('lỗi RBAC')),
    } as unknown as RbacService;
    await expect(
      new NotificationService(prisma, rbac).emit(
        NotificationTopic.orders_create,
        emitInput,
      ),
    ).resolves.toBeUndefined();
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('cache cấu hình: gọi emit() 2 lần liên tiếp cùng topic chỉ query settings 1 lần', async () => {
    const prisma = fakePrisma();
    const rbac = fakeRbac([9n]);
    const svc = new NotificationService(prisma, rbac);
    await svc.emit(NotificationTopic.orders_create, emitInput);
    await svc.emit(NotificationTopic.orders_create, emitInput);
    expect(prisma.notificationSetting.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('NotificationService — cấu hình & cache invalidation', () => {
  it('isTopicEnabled phản ánh đúng app_enabled', async () => {
    const prisma = fakePrisma({
      notificationSetting: {
        findMany: jest
          .fn()
          .mockResolvedValue([makeSetting({ appEnabled: false })]),
      },
    });
    const svc = new NotificationService(prisma, fakeRbac());
    expect(await svc.isTopicEnabled(NotificationTopic.orders_create)).toBe(
      false,
    );
  });

  it('updateSetting() invalidate cache — lần đọc SAU đó phải query lại settings', async () => {
    const prisma = fakePrisma();
    const svc = new NotificationService(prisma, fakeRbac());

    await svc.isTopicEnabled(NotificationTopic.orders_create); // query #1, vào cache
    await svc.isTopicEnabled(NotificationTopic.orders_create); // cache hit, không query thêm
    expect(prisma.notificationSetting.findMany).toHaveBeenCalledTimes(1);

    await svc.updateSetting('orders/create', { app_enabled: false });

    await svc.isTopicEnabled(NotificationTopic.orders_create); // cache đã bị xoá ⇒ query lại
    expect(prisma.notificationSetting.findMany).toHaveBeenCalledTimes(2);
  });

  it('updateSetting() với topic không tồn tại (chuỗi wire sai) → NOT_FOUND, không đụng DB', async () => {
    const prisma = fakePrisma();
    const svc = new NotificationService(prisma, fakeRbac());
    await expect(
      svc.updateSetting('khong/ton-tai', { app_enabled: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' } as Partial<BusinessException>);
    expect(prisma.notificationSetting.update).not.toHaveBeenCalled();
  });

  it('updateSetting() với recipient_permissions chứa key không tồn tại → INVALID_PERMISSION, không ghi', async () => {
    const prisma = fakePrisma({
      permission: { findMany: jest.fn().mockResolvedValue([]) }, // không key nào khớp
    });
    const svc = new NotificationService(prisma, fakeRbac());
    await expect(
      svc.updateSetting('orders/create', {
        recipient_permissions: ['sai:chinh_ta'],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PERMISSION' });
    expect(prisma.notificationSetting.update).not.toHaveBeenCalled();
  });

  it('updateSetting() hợp lệ → gọi update với đúng topic enum (đã map ngược từ chuỗi wire)', async () => {
    const prisma = fakePrisma();
    const svc = new NotificationService(prisma, fakeRbac());
    await svc.updateSetting('inventory/negative', { app_enabled: false });
    expect(prisma.notificationSetting.update).toHaveBeenCalledWith({
      where: { topic: NotificationTopic.inventory_negative },
      data: { appEnabled: false },
    });
  });
});

describe('NotificationService.list — riêng tư & phân trang', () => {
  it('LUÔN lọc theo userId của người gọi — không có cách nào bỏ qua từ bên ngoài', async () => {
    const prisma = fakePrisma();
    const svc = new NotificationService(prisma, fakeRbac());
    await svc.list(user(9n), {});
    expect(prisma.notificationRecipient.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 9n }),
      }),
    );
  });

  it('before_id không phải số nguyên → BỎ QUA điều kiện lọc, không BigInt("abc") làm crash', async () => {
    const prisma = fakePrisma();
    const svc = new NotificationService(prisma, fakeRbac());
    await svc.list(user(9n), { before_id: 'abc' });
    const call = (prisma.notificationRecipient.findMany as jest.Mock).mock
      .calls[0][0];
    expect(call.where.notificationId).toBeUndefined();
  });

  it('before_id hợp lệ → truyền notificationId < before_id vào Prisma', async () => {
    const prisma = fakePrisma();
    const svc = new NotificationService(prisma, fakeRbac());
    await svc.list(user(9n), { before_id: '100' });
    const call = (prisma.notificationRecipient.findMany as jest.Mock).mock
      .calls[0][0];
    expect(call.where.notificationId).toEqual({ lt: 100n });
  });

  it('lấy dư 1 dòng để tính has_more — không gọi count() thừa', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      notificationId: BigInt(10 - i),
      userId: 9n,
      readOn: null,
      notification: {
        id: BigInt(10 - i),
        topic: NotificationTopic.orders_create,
        subjectType: 'order',
        subjectId: 1n,
        locationId: 1n,
        title: 't',
        payload: null,
        createdOn: new Date(),
      },
    }));
    const prisma = fakePrisma({
      notificationRecipient: {
        findMany: jest.fn().mockResolvedValue(rows), // limit=5 nhưng trả 6 dòng
      },
    });
    const svc = new NotificationService(prisma, fakeRbac());
    const res = await svc.list(user(9n), { limit: 5 });

    expect((prisma.notificationRecipient.findMany as jest.Mock).mock.calls[0][0].take).toBe(6);
    expect(res.data).toHaveLength(5); // cắt bớt dòng dư trước khi trả ra
    expect(res.has_more).toBe(true);
    expect(res.next_before_id).toBe(res.data[4].id);
  });

  it('unread_only=true → thêm điều kiện readOn: null', async () => {
    const prisma = fakePrisma();
    const svc = new NotificationService(prisma, fakeRbac());
    await svc.list(user(9n), { unread_only: true });
    const call = (prisma.notificationRecipient.findMany as jest.Mock).mock
      .calls[0][0];
    expect(call.where.readOn).toBeNull();
  });
});

describe('NotificationService.markRead', () => {
  it('mảng ids rỗng → trả updated:0 ngay, KHÔNG gọi Prisma', async () => {
    const prisma = fakePrisma();
    const svc = new NotificationService(prisma, fakeRbac());
    const res = await svc.markRead(user(9n), []);
    expect(res).toEqual({ updated: 0 });
    expect(prisma.notificationRecipient.updateMany).not.toHaveBeenCalled();
  });

  it('id không phải số (BigInt("abc") ném SyntaxError) → BusinessException INVALID_ID, không phải 500', async () => {
    const prisma = fakePrisma();
    const svc = new NotificationService(prisma, fakeRbac());
    await expect(svc.markRead(user(9n), ['abc'])).rejects.toMatchObject({
      code: 'INVALID_ID',
    });
    expect(prisma.notificationRecipient.updateMany).not.toHaveBeenCalled();
  });

  it('id hợp lệ → updateMany lọc theo userId CỦA NGƯỜI GỌI + notificationId, không tin id từ input đơn thuần', async () => {
    const prisma = fakePrisma({
      notificationRecipient: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    });
    const svc = new NotificationService(prisma, fakeRbac());
    const res = await svc.markRead(user(9n), ['5']);

    expect(res).toEqual({ updated: 1 });
    expect(prisma.notificationRecipient.updateMany).toHaveBeenCalledWith({
      where: { userId: 9n, notificationId: { in: [5n] }, readOn: null },
      data: { readOn: expect.any(Date) },
    });
  });
});
