import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  buildCustomerGroupWhere,
  parseRules,
  ruleCatalog,
} from './customer-group-rules';
import {
  CreateCustomerGroupDto,
  PreviewCustomerGroupDto,
  UpdateCustomerGroupDto,
} from './customer.dto';

type GroupWithCount = Prisma.CustomerGroupGetPayload<{
  include: { _count: { select: { members: true } } };
}>;

@Injectable()
export class CustomerGroupService {
  constructor(private prisma: PrismaService) {}

  /** Danh mục điều kiện cho builder nhóm tự động */
  ruleOptions() {
    return { data: ruleCatalog() };
  }

  private serialize(g: GroupWithCount) {
    return {
      id: g.id.toString(),
      sapo_id: g.sapoId?.toString() ?? null,
      code: g.code,
      name: g.name,
      note: g.note,
      type: g.type,
      disjunctive: g.disjunctive,
      rules: parseRules(g.rules),
      // Đếm trực tiếp từ bảng thành viên nên luôn khớp với danh sách hiển thị;
      // cột `customers_count` trong DB được ghi lại theo số này ở mọi chỗ đổi
      // thành viên, để dành cho việc đồng bộ Sapo sau này.
      customers_count: g._count.members,
      created_on: g.createdOn.toISOString(),
      modified_on: g.modifiedOn.toISOString(),
    };
  }

  private async findOrThrow(id: bigint): Promise<GroupWithCount> {
    const g = await this.prisma.customerGroup.findUnique({
      where: { id },
      include: { _count: { select: { members: true } } },
    });
    if (!g) throw new NotFoundException('Không tìm thấy nhóm khách hàng');
    return g;
  }

  /** Ghi lại `customers_count` cho khớp số thành viên thật */
  private async syncCount(groupId: bigint) {
    const total = await this.prisma.customerGroupMember.count({
      where: { customerGroupId: groupId },
    });
    await this.prisma.customerGroup.update({
      where: { id: groupId },
      data: { customersCount: total },
    });
    return total;
  }

  async list() {
    const rows = await this.prisma.customerGroup.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { members: true } } },
    });
    return { data: rows.map((g) => this.serialize(g)) };
  }

  async findOne(id: bigint) {
    return { data: this.serialize(await this.findOrThrow(id)) };
  }

  async create(dto: CreateCustomerGroupDto) {
    // `code` là mã nội bộ (Sapo không có) — bảng giá tham chiếu theo mã này.
    const code = dto.code?.trim() || `NHOM-${Date.now()}`;
    const dup = await this.prisma.customerGroup.findUnique({ where: { code } });
    if (dup) throw new ConflictException('CODE_EXISTS');

    const type = dto.type === 'auto' ? 'auto' : 'manual';
    const rules = parseRules(dto.rules);
    if (type === 'auto') {
      // Kiểm tra rule trước khi tạo để không đẻ ra nhóm tự động hỏng.
      await buildCustomerGroupWhere(this.prisma, rules, dto.disjunctive ?? false);
    }

    const g = await this.prisma.customerGroup.create({
      data: {
        code,
        name: dto.name.trim(),
        note: dto.note?.trim() || null,
        type,
        disjunctive: dto.disjunctive ?? false,
        // Luôn lưu điều kiện, kể cả nhóm thủ công: chuyển sang thủ công là
        // *tạm ngưng* áp dụng, không phải xoá. Nhóm đồng bộ từ Sapo dựa vào
        // điều này để giữ nguyên rule gốc trong lúc bị khoá an toàn.
        rules: rules as unknown as Prisma.InputJsonValue,
      },
      include: { _count: { select: { members: true } } },
    });

    if (type === 'auto') await this.recalculate(g.id);
    return this.findOne(g.id);
  }

  async update(id: bigint, dto: UpdateCustomerGroupDto) {
    const current = await this.findOrThrow(id);
    const type = dto.type ? (dto.type === 'auto' ? 'auto' : 'manual') : current.type;
    const disjunctive = dto.disjunctive ?? current.disjunctive;
    const rules = dto.rules !== undefined ? parseRules(dto.rules) : parseRules(current.rules);

    if (type === 'auto') {
      await buildCustomerGroupWhere(this.prisma, rules, disjunctive);
    }

    await this.prisma.customerGroup.update({
      where: { id },
      data: {
        name: dto.name?.trim() ?? undefined,
        note: dto.note?.trim() ?? undefined,
        type,
        disjunctive,
        rules: rules as unknown as Prisma.InputJsonValue,
      },
    });

    if (type === 'auto') {
      await this.recalculate(id);
    } else if (current.type === 'auto') {
      // Chuyển auto -> thủ công: giữ nguyên thành viên đang có làm điểm bắt đầu.
      await this.syncCount(id);
    }
    return this.findOne(id);
  }

  async remove(id: bigint) {
    await this.findOrThrow(id);
    const usedByPriceList = await this.prisma.priceList.count({
      where: { customerGroupId: id },
    });
    if (usedByPriceList > 0) throw new ConflictException('GROUP_IN_USE');

    await this.prisma.customerGroup.delete({ where: { id } });
    return { id: id.toString(), deleted: true };
  }

  /** Đếm thử số khách khớp bộ điều kiện — dùng cho builder trước khi lưu */
  async preview(dto: PreviewCustomerGroupDto) {
    const where = await buildCustomerGroupWhere(
      this.prisma,
      parseRules(dto.rules),
      dto.disjunctive ?? false,
    );
    const [total, sample] = await Promise.all([
      this.prisma.customer.count({ where }),
      this.prisma.customer.findMany({
        where,
        take: 5,
        orderBy: { totalSpent: 'desc' },
        select: { id: true, firstName: true, lastName: true, phone: true },
      }),
    ]);
    return {
      total,
      sample: sample.map((c) => ({
        id: c.id.toString(),
        name:
          [c.firstName, c.lastName].filter(Boolean).join(' ') || c.phone || '(chưa đặt tên)',
      })),
    };
  }

  /**
   * Tính lại toàn bộ thành viên của một nhóm tự động.
   * Chỉ thêm/bớt phần chênh lệch để giữ `created_on` (ngày vào nhóm) của
   * những khách vẫn còn thoả điều kiện.
   */
  async recalculate(id: bigint) {
    const g = await this.findOrThrow(id);
    if (g.type !== 'auto') throw new ConflictException('GROUP_NOT_AUTO');

    const where = await buildCustomerGroupWhere(
      this.prisma,
      parseRules(g.rules),
      g.disjunctive,
    );
    const [matched, current] = await Promise.all([
      this.prisma.customer.findMany({ where, select: { id: true } }),
      this.prisma.customerGroupMember.findMany({
        where: { customerGroupId: id },
        select: { customerId: true },
      }),
    ]);

    const nextIds = new Set(matched.map((c) => c.id));
    const currentIds = new Set(current.map((m) => m.customerId));
    const toAdd = [...nextIds].filter((cid) => !currentIds.has(cid));
    const toRemove = [...currentIds].filter((cid) => !nextIds.has(cid));

    await this.prisma.$transaction([
      ...(toRemove.length
        ? [
            this.prisma.customerGroupMember.deleteMany({
              where: { customerGroupId: id, customerId: { in: toRemove } },
            }),
          ]
        : []),
      ...(toAdd.length
        ? [
            this.prisma.customerGroupMember.createMany({
              data: toAdd.map((cid) => ({ customerId: cid, customerGroupId: id })),
              skipDuplicates: true,
            }),
          ]
        : []),
      this.prisma.customerGroup.update({
        where: { id },
        data: { customersCount: nextIds.size },
      }),
    ]);

    return { total: nextIds.size, added: toAdd.length, removed: toRemove.length };
  }

  /**
   * Cập nhật tư cách thành viên của **một khách** trong mọi nhóm tự động —
   * gọi sau khi tạo/sửa khách để nhóm tự động luôn đúng mà không phải quét lại
   * toàn bộ danh sách khách hàng.
   */
  async syncCustomerAutoGroups(customerId: bigint) {
    const groups = await this.prisma.customerGroup.findMany({
      where: { type: 'auto' },
      select: { id: true, rules: true, disjunctive: true },
    });

    for (const g of groups) {
      let matches: boolean;
      try {
        const where = await buildCustomerGroupWhere(
          this.prisma,
          parseRules(g.rules),
          g.disjunctive,
        );
        matches =
          (await this.prisma.customer.count({
            where: { AND: [where, { id: customerId }] },
          })) > 0;
      } catch {
        // Nhóm tự động có rule hỏng (VD cột đã bị gỡ) — bỏ qua, đừng chặn việc
        // lưu khách hàng; nhóm sẽ báo lỗi khi người dùng bấm "Tính lại".
        continue;
      }

      if (matches) {
        const { count } = await this.prisma.customerGroupMember.createMany({
          data: [{ customerId, customerGroupId: g.id }],
          skipDuplicates: true,
        });
        if (count > 0) await this.syncCount(g.id);
      } else {
        const { count } = await this.prisma.customerGroupMember.deleteMany({
          where: { customerGroupId: g.id, customerId },
        });
        if (count > 0) await this.syncCount(g.id);
      }
    }
  }

  /** Danh sách khách thuộc nhóm (tương ứng /admin/customer_groups/{id}/customers.json) */
  async members(id: bigint, page: number, limit: number) {
    await this.findOrThrow(id);
    const take = Math.min(Math.max(limit || 20, 1), 250);
    const skip = (Math.max(page || 1, 1) - 1) * take;

    const [rows, total] = await Promise.all([
      this.prisma.customerGroupMember.findMany({
        where: { customerGroupId: id },
        include: { customer: true },
        orderBy: { customer: { totalSpent: 'desc' } },
        skip,
        take,
      }),
      this.prisma.customerGroupMember.count({ where: { customerGroupId: id } }),
    ]);

    return {
      data: rows.map(({ customer: c }) => ({
        id: c.id.toString(),
        first_name: c.firstName,
        last_name: c.lastName,
        label: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.phone || c.email,
        phone: c.phone,
        email: c.email,
        state: c.state,
        gender: c.gender,
        orders_count: c.ordersCount,
        total_spent: Number(c.totalSpent),
      })),
      total,
      page: Math.max(page || 1, 1),
      limit: take,
      total_pages: Math.ceil(total / take),
    };
  }

  /** Thêm khách vào nhóm thủ công (giữ nguyên thành viên cũ) */
  async addMembers(id: bigint, customerIds: string[]) {
    const g = await this.findOrThrow(id);
    // Thành viên nhóm tự động do điều kiện quyết định — thêm tay sẽ bị "Tính
    // lại" xoá ngay, nên chặn hẳn cho khỏi hiểu nhầm.
    if (g.type === 'auto') throw new ConflictException('GROUP_IS_AUTO');

    const { count } = await this.prisma.customerGroupMember.createMany({
      data: customerIds.map((cid) => ({
        customerId: BigInt(cid),
        customerGroupId: id,
      })),
      skipDuplicates: true,
    });
    const total = await this.syncCount(id);
    return { added: count, skipped: customerIds.length - count, total };
  }

  async removeMember(id: bigint, customerId: bigint) {
    const g = await this.findOrThrow(id);
    if (g.type === 'auto') throw new ConflictException('GROUP_IS_AUTO');

    await this.prisma.customerGroupMember.deleteMany({
      where: { customerGroupId: id, customerId },
    });
    const total = await this.syncCount(id);
    return { removed: true, total };
  }
}
