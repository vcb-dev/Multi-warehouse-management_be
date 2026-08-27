import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { isAdminUser } from '../../common/auth/access';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import {
  CreateSavedFilterDto,
  ListSavedFiltersQueryDto,
  UpdateSavedFilterDto,
} from './saved-filter.dto';

type SavedFilterRow = {
  id: bigint;
  resource: string;
  name: string;
  query: string;
  ownerId: bigint | null;
  position: number;
};

function serialize(row: SavedFilterRow) {
  return {
    id: row.id.toString(),
    resource: row.resource,
    name: row.name,
    query: row.query,
    /// Bộ lọc dùng chung: ai cũng thấy, chỉ admin sửa được.
    shared: row.ownerId === null,
    position: row.position,
  };
}

@Injectable()
export class SavedFilterService {
  constructor(private prisma: PrismaService) {}

  /** Bộ lọc riêng của người dùng cộng với bộ lọc dùng chung của shop. */
  async list(query: ListSavedFiltersQueryDto, user: AuthUser) {
    const rows = await this.prisma.savedFilter.findMany({
      where: {
        resource: query.resource,
        OR: [{ ownerId: user.userId }, { ownerId: null }],
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
    return { data: rows.map(serialize) };
  }

  async create(dto: CreateSavedFilterDto, user: AuthUser) {
    if (dto.shared && !isAdminUser(user)) {
      throw new ForbiddenException(
        'Chỉ admin mới lưu được bộ lọc dùng chung cho cả shop.',
      );
    }
    const ownerId = dto.shared ? null : user.userId;

    // Tab mới xếp cuối hàng, giữ nguyên thứ tự những tab đang có.
    const last = await this.prisma.savedFilter.findFirst({
      where: { resource: dto.resource, ownerId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });

    const row = await this.prisma.savedFilter.create({
      data: {
        resource: dto.resource,
        name: dto.name.trim(),
        query: dto.query,
        ownerId,
        position: (last?.position ?? -1) + 1,
      },
    });
    return { data: serialize(row) };
  }

  async update(id: string, dto: UpdateSavedFilterDto, user: AuthUser) {
    const row = await this.mustOwn(id, user);
    const updated = await this.prisma.savedFilter.update({
      where: { id: row.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.query !== undefined ? { query: dto.query } : {}),
        ...(dto.position !== undefined ? { position: dto.position } : {}),
      },
    });
    return { data: serialize(updated) };
  }

  async remove(id: string, user: AuthUser) {
    const row = await this.mustOwn(id, user);
    await this.prisma.savedFilter.delete({ where: { id: row.id } });
    return { ok: true };
  }

  /**
   * Chỉ chủ sở hữu sửa/xoá được bộ lọc riêng; bộ lọc dùng chung dành cho admin.
   * Trả 404 thay vì 403 khi bộ lọc thuộc về người khác — không tiết lộ là nó tồn tại.
   */
  private async mustOwn(id: string, user: AuthUser) {
    const row = await this.prisma.savedFilter.findUnique({
      where: { id: BigInt(id) },
    });
    if (!row) throw new NotFoundException('Không tìm thấy bộ lọc');

    if (row.ownerId === null) {
      if (!isAdminUser(user)) {
        throw new ForbiddenException(
          'Chỉ admin mới sửa được bộ lọc dùng chung cho cả shop.',
        );
      }
      return row;
    }

    if (row.ownerId !== user.userId) {
      throw new NotFoundException('Không tìm thấy bộ lọc');
    }
    return row;
  }
}
