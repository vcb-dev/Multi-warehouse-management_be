import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateCustomerGroupDto,
  SetGroupMembersDto,
  UpdateCustomerGroupDto,
} from './customer.dto';

/** Sapo `customer_groups` — nhóm khách hàng (auto theo rules, hoặc chọn tay). */
@ApiTags('customer-groups')
@ApiBearerAuth()
@Controller('customer-groups')
export class CustomerGroupsController {
  constructor(private prisma: PrismaService) {}

  private async findOrThrow(id: bigint) {
    const g = await this.prisma.customerGroup.findUnique({
      where: { id },
      include: { _count: { select: { members: true } } },
    });
    if (!g) throw new NotFoundException('Không tìm thấy nhóm khách hàng');
    return g;
  }

  private serialize(g: {
    id: bigint;
    sapoId: bigint | null;
    code: string;
    name: string;
    note: string | null;
    type: string;
    disjunctive: boolean;
    rules: unknown;
    customersCount: number;
    createdOn: Date;
    modifiedOn: Date;
    _count: { members: number };
  }) {
    return {
      id: g.id.toString(),
      sapo_id: g.sapoId?.toString() ?? null,
      code: g.code,
      name: g.name,
      note: g.note,
      type: g.type,
      disjunctive: g.disjunctive,
      rules: g.rules,
      // `customers_count` là số Sapo báo (tính trên toàn hệ thống Sapo);
      // `members_count` là số khách đã đồng bộ về DB này.
      customers_count: g.customersCount,
      members_count: g._count.members,
      created_on: g.createdOn.toISOString(),
      modified_on: g.modifiedOn.toISOString(),
    };
  }

  @Get()
  @RequirePermission('customer:view')
  async list() {
    const rows = await this.prisma.customerGroup.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { members: true } } },
    });
    return { data: rows.map((g) => this.serialize(g)) };
  }

  @Get(':id')
  @RequirePermission('customer:view')
  async findOne(@Param('id') id: string) {
    return { data: this.serialize(await this.findOrThrow(BigInt(id))) };
  }

  @Post()
  @RequirePermission('customer:manage')
  async create(@Body() dto: CreateCustomerGroupDto) {
    // `code` là mã nội bộ (Sapo không có) — bảng giá tham chiếu theo mã này.
    const code = dto.code?.trim() || `NHOM-${Date.now()}`;
    const dup = await this.prisma.customerGroup.findUnique({ where: { code } });
    if (dup) throw new ConflictException('CODE_EXISTS');

    const g = await this.prisma.customerGroup.create({
      data: {
        code,
        name: dto.name.trim(),
        note: dto.note?.trim() || null,
        type: dto.type || 'manual',
        disjunctive: dto.disjunctive ?? false,
        rules: (dto.rules as never) ?? undefined,
      },
      include: { _count: { select: { members: true } } },
    });
    return { data: this.serialize(g) };
  }

  @Put(':id')
  @RequirePermission('customer:manage')
  async update(@Param('id') id: string, @Body() dto: UpdateCustomerGroupDto) {
    await this.findOrThrow(BigInt(id));
    const g = await this.prisma.customerGroup.update({
      where: { id: BigInt(id) },
      data: {
        name: dto.name?.trim() ?? undefined,
        note: dto.note?.trim() ?? undefined,
        type: dto.type ?? undefined,
        disjunctive: dto.disjunctive ?? undefined,
        rules: (dto.rules as never) ?? undefined,
      },
      include: { _count: { select: { members: true } } },
    });
    return { data: this.serialize(g) };
  }

  @Delete(':id')
  @RequirePermission('customer:manage')
  async remove(@Param('id') id: string) {
    const groupId = BigInt(id);
    await this.findOrThrow(groupId);
    const usedByPriceList = await this.prisma.priceList.count({
      where: { customerGroupId: groupId },
    });
    if (usedByPriceList > 0) {
      throw new ConflictException('GROUP_IN_USE');
    }
    await this.prisma.customerGroup.delete({ where: { id: groupId } });
    return { id, deleted: true };
  }

  /** Danh sách khách thuộc nhóm (tương ứng /admin/customer_groups/{id}/customers.json) */
  @Get(':id/customers')
  @RequirePermission('customer:view')
  async customers(
    @Param('id') id: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    const groupId = BigInt(id);
    await this.findOrThrow(groupId);

    const take = Math.min(Number(limit) || 20, 250);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

    const [rows, total] = await Promise.all([
      this.prisma.customerGroupMember.findMany({
        where: { customerGroupId: groupId },
        include: { customer: true },
        orderBy: { customer: { totalSpent: 'desc' } },
        skip,
        take,
      }),
      this.prisma.customerGroupMember.count({ where: { customerGroupId: groupId } }),
    ]);

    return {
      data: rows.map(({ customer: c }) => ({
        id: c.id.toString(),
        first_name: c.firstName,
        last_name: c.lastName,
        name: [c.firstName, c.lastName].filter(Boolean).join(' ') || null,
        phone: c.phone,
        email: c.email,
        state: c.state,
        orders_count: c.ordersCount,
        total_spent: Number(c.totalSpent),
      })),
      total,
      page: Number(page) || 1,
      limit: take,
      total_pages: Math.ceil(total / take),
    };
  }

  /** Thêm khách vào nhóm (giữ nguyên thành viên cũ) */
  @Post(':id/customers')
  @RequirePermission('customer:manage')
  async addMembers(@Param('id') id: string, @Body() dto: SetGroupMembersDto) {
    const groupId = BigInt(id);
    await this.findOrThrow(groupId);
    await this.prisma.customerGroupMember.createMany({
      data: dto.customer_ids.map((cid) => ({
        customerId: BigInt(cid),
        customerGroupId: groupId,
      })),
      skipDuplicates: true,
    });
    return { added: dto.customer_ids.length };
  }

  @Delete(':id/customers/:customerId')
  @RequirePermission('customer:manage')
  async removeMember(
    @Param('id') id: string,
    @Param('customerId') customerId: string,
  ) {
    await this.prisma.customerGroupMember.deleteMany({
      where: { customerGroupId: BigInt(id), customerId: BigInt(customerId) },
    });
    return { removed: true };
  }
}
