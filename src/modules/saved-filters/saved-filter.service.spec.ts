import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SavedFilterService } from './saved-filter.service';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import type { PrismaService } from '../../prisma/prisma.service';

type Row = {
  id: bigint;
  resource: string;
  name: string;
  query: string;
  ownerId: bigint | null;
  position: number;
};

function makeUser(userId: bigint, isAdmin = false): AuthUser {
  return {
    userId,
    email: `u${userId}@example.com`,
    roles: isAdmin ? ['admin'] : ['staff'],
    locationIds: [],
    isAdmin,
  };
}

/** Prisma giả — chỉ những phương thức mà service thật sự gọi tới. */
function makePrisma(row: Row | null) {
  const savedFilter = {
    findUnique: jest.fn().mockResolvedValue(row),
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue(row ? [row] : []),
    create: jest.fn(async ({ data }: { data: Partial<Row> }) => ({
      id: 99n,
      position: 0,
      ...data,
    })),
    update: jest.fn(async ({ data }: { data: Partial<Row> }) => ({
      ...row!,
      ...data,
    })),
    delete: jest.fn().mockResolvedValue(row),
  };
  return { prisma: { savedFilter } as unknown as PrismaService, savedFilter };
}

const RIENG: Row = {
  id: 1n,
  resource: 'orders',
  name: 'Đơn SOS',
  query: 'financial_status=pending',
  ownerId: 7n,
  position: 0,
};
const DUNG_CHUNG: Row = { ...RIENG, id: 2n, name: 'Đơn hoàn', ownerId: null };

describe('SavedFilterService — quyền sửa/xoá', () => {
  it('chủ sở hữu sửa được bộ lọc của mình', async () => {
    const { prisma } = makePrisma(RIENG);
    const svc = new SavedFilterService(prisma);
    const res = await svc.update('1', { name: 'Đổi tên' }, makeUser(7n));
    expect(res.data.name).toBe('Đổi tên');
  });

  it('người khác thấy 404 chứ không phải 403 — không lộ là bộ lọc có tồn tại', async () => {
    const { prisma } = makePrisma(RIENG);
    const svc = new SavedFilterService(prisma);
    await expect(svc.update('1', { name: 'X' }, makeUser(8n))).rejects.toThrow(
      NotFoundException,
    );
  });

  it('admin cũng không mượn được bộ lọc riêng của người khác', async () => {
    const { prisma } = makePrisma(RIENG);
    const svc = new SavedFilterService(prisma);
    await expect(svc.remove('1', makeUser(8n, true))).rejects.toThrow(
      NotFoundException,
    );
  });

  it('bộ lọc dùng chung: nhân viên thường bị chặn', async () => {
    const { prisma } = makePrisma(DUNG_CHUNG);
    const svc = new SavedFilterService(prisma);
    await expect(svc.remove('2', makeUser(7n))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('bộ lọc dùng chung: admin sửa được', async () => {
    const { prisma } = makePrisma(DUNG_CHUNG);
    const svc = new SavedFilterService(prisma);
    const res = await svc.update(
      '2',
      { name: 'Đơn hoàn 2' },
      makeUser(9n, true),
    );
    expect(res.data.shared).toBe(true);
  });

  it('bộ lọc không tồn tại trả 404', async () => {
    const { prisma } = makePrisma(null);
    const svc = new SavedFilterService(prisma);
    await expect(svc.remove('404', makeUser(7n))).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('SavedFilterService — tạo mới', () => {
  it('chỉ admin lưu được bộ lọc dùng chung', async () => {
    const { prisma } = makePrisma(null);
    const svc = new SavedFilterService(prisma);
    await expect(
      svc.create(
        { resource: 'orders', name: 'Chung', query: '', shared: true },
        makeUser(7n),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('bộ lọc riêng gắn với người tạo, tab mới xếp cuối hàng', async () => {
    const { prisma, savedFilter } = makePrisma(null);
    savedFilter.findFirst.mockResolvedValue({ position: 4 });
    const svc = new SavedFilterService(prisma);
    const res = await svc.create(
      { resource: 'orders', name: '  Đơn SOS  ', query: 'tags=sos' },
      makeUser(7n),
    );
    expect(savedFilter.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ownerId: 7n,
        name: 'Đơn SOS',
        position: 5,
      }),
    });
    expect(res.data.shared).toBe(false);
  });

  it('lưu được bộ lọc rỗng — "tất cả" cũng là một bộ lọc hợp lệ', async () => {
    const { prisma, savedFilter } = makePrisma(null);
    const svc = new SavedFilterService(prisma);
    await svc.create(
      { resource: 'inventory', name: 'Tất cả', query: '' },
      makeUser(7n),
    );
    expect(savedFilter.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ query: '', position: 0 }),
    });
  });
});
