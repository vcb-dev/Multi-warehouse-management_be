import { NotFoundException } from '@nestjs/common';
import { CategoryService } from '../src/modules/categories/category.service';
import type { PrismaService } from '../src/prisma/prisma.service';

describe('CategoryService — create', () => {
  it('báo lỗi khi parent_id không tồn tại', async () => {
    const prisma = {
      category: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
    } as unknown as PrismaService;

    const service = new CategoryService(prisma);

    await expect(
      service.create({
        name: 'Danh mục con',
        condition_type: 'manual',
        parent_id: '999999',
      }),
    ).rejects.toThrow(NotFoundException);

    expect(prisma.category.create).not.toHaveBeenCalled();
  });
});
