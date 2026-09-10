import { NotFoundException } from '@nestjs/common';
import { OrderService } from './order.service';
import { UpdateOrderItemDto } from './order.dto';
import type { AuthUser } from '../../common/decorators/current-user.decorator';

/**
 * Ghi chú theo từng dòng hàng — không chạm DB: repository và transaction đều là
 * stub, phần cần khẳng định là những gì service GHI xuống (giá trị đã chuẩn hoá,
 * vết lịch sử) và những gì service CHẶN.
 */
jest.mock('./order.serializer', () => ({
  ...jest.requireActual('./order.serializer'),
  // Serialize đơn đầy đủ cần một fixture 40 dòng toàn null — ở đây chỉ quan tâm
  // service ghi đúng cái gì, nên trả thẳng bản ghi.
  serializeOrderDetail: (order: unknown) => order,
}));

const admin: AuthUser = {
  userId: 7n,
  email: 'admin@example.com',
  roles: ['admin'],
  locationIds: [],
  isAdmin: true,
};

/** Nhân viên chỉ có quyền sửa đơn ở kho 99 */
const staffKhacKho: AuthUser = {
  userId: 8n,
  email: 'staff@example.com',
  roles: ['sales'],
  locationIds: [],
  isAdmin: false,
  systemPermissions: [],
  warehousePermissions: { '99': ['order:update'] },
};

type Order = {
  id: bigint;
  name: string;
  locationId: bigint;
  status: string;
  confirmedOn: Date | null;
  items: { id: bigint; sku: string }[];
};

function setup(order: Order | null) {
  const itemUpdate = jest.fn().mockResolvedValue({});
  const logCreate = jest.fn().mockResolvedValue({});
  const findOrder = jest
    .fn()
    .mockResolvedValue({ id: order?.id, reloaded: true });

  const tx = {
    orderItem: { update: itemUpdate },
    activityLog: { create: logCreate },
    order: { findUniqueOrThrow: findOrder },
  };
  const repo = {
    findById: jest.fn().mockResolvedValue(order),
    client: {
      $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
    },
  };

  const service = new OrderService(
    repo as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );
  return { service, itemUpdate, logCreate, findOrder };
}

const donDaXacNhan: Order = {
  id: 1n,
  name: 'DH0001',
  locationId: 1n,
  // Đơn đã xác nhận và đang xử lý — `update()` chặn sửa ở trạng thái này.
  status: 'open',
  confirmedOn: new Date('2026-09-01T00:00:00.000Z'),
  items: [
    { id: 10n, sku: 'NHAN-01' },
    { id: 11n, sku: 'DAY-02' },
  ],
};

const dto = (note?: string) => ({ note }) as UpdateOrderItemDto;

describe('OrderService.updateItemNote', () => {
  it('ghi được cả khi đơn đã xác nhận — đúng lúc phát sinh yêu cầu gia công', async () => {
    const { service, itemUpdate } = setup(donDaXacNhan);

    await service.updateItemNote(1n, 10n, dto('Khắc tên An'), admin);

    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: 10n },
      data: { note: 'Khắc tên An' },
    });
  });

  it('cắt khoảng trắng, ô rỗng nghĩa là xoá ghi chú', async () => {
    const { service, itemUpdate } = setup(donDaXacNhan);

    await service.updateItemNote(1n, 10n, dto('  Nới size 16  '), admin);
    expect(itemUpdate).toHaveBeenLastCalledWith({
      where: { id: 10n },
      data: { note: 'Nới size 16' },
    });

    await service.updateItemNote(1n, 10n, dto('   '), admin);
    expect(itemUpdate).toHaveBeenLastCalledWith({
      where: { id: 10n },
      data: { note: null },
    });
  });

  it('lưu nội dung vào lịch sử đơn', async () => {
    const { service, logCreate } = setup(donDaXacNhan);

    await service.updateItemNote(1n, 11n, dto('Gói riêng'), admin);

    expect(logCreate).toHaveBeenCalledWith({
      data: {
        userId: 7n,
        action: 'order.item_note',
        entityType: 'order',
        entityId: 1n,
        metadata: { code: 'DH0001', sku: 'DAY-02', note: 'Gói riêng' },
      },
    });
  });

  it('không ghi lên dòng của đơn khác', async () => {
    const { service, itemUpdate } = setup(donDaXacNhan);

    await expect(
      service.updateItemNote(1n, 999n, dto('x'), admin),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(itemUpdate).not.toHaveBeenCalled();
  });

  it('không tìm thấy đơn thì báo 404', async () => {
    const { service } = setup(null);

    await expect(
      service.updateItemNote(1n, 10n, dto('x'), admin),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('chặn người không có quyền sửa đơn ở kho đó', async () => {
    const { service, itemUpdate } = setup(donDaXacNhan);

    await expect(
      service.updateItemNote(1n, 10n, dto('x'), staffKhacKho),
    ).rejects.toThrow();
    expect(itemUpdate).not.toHaveBeenCalled();
  });
});
