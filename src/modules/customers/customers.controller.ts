import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { findCustomerIdsByQuery } from '../../common/search/unaccent-search';
import { CustomerDebtService } from './customer-debt.service';
import { CustomerService } from './customer.service';
import {
  CreateCustomerDebtAdjustmentDto,
  CreateCustomerDto,
  CustomerDuplicateQueryDto,
  ListCustomerLedgerQueryDto,
  ListCustomersQueryDto,
  UpdateCustomerDto,
} from './customer.dto';

/** Số dòng tối đa của dropdown chọn khách */
const OPTIONS_LIMIT = 20;

@ApiTags('customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(
    private prisma: PrismaService,
    private debt: CustomerDebtService,
    private customers: CustomerService,
  ) {}

  /** Danh sách đầy đủ (phân trang + lọc) cho màn hình quản lý khách hàng. */
  @Get()
  @RequirePermission('customer:view')
  list(@Query() query: ListCustomersQueryDto) {
    return this.customers.list(query);
  }

  /** Dropdown chọn khách khi tạo đơn — chỉ id + nhãn, tối đa 20 dòng. */
  @Get('options')
  @RequirePermission('customer:view', 'order:create')
  async options(@Query('q') q?: string) {
    const term = q?.trim();
    // Cắt ngay trong SQL: dropdown chỉ hiện 20 dòng, mà nạp hết id ứng viên rồi
    // mới `in` là vừa chậm vừa có ngày vượt trần bind variable của Postgres.
    const ids = term
      ? await findCustomerIdsByQuery(this.prisma, term, OPTIONS_LIMIT)
      : null;
    const rows = await this.prisma.customer.findMany({
      where: ids ? { id: { in: ids } } : undefined,
      take: OPTIONS_LIMIT,
      orderBy: { id: 'desc' },
    });
    // `findMany` trả về theo thứ tự của nó, nên phải xếp lại theo đúng thứ tự
    // ưu tiên mà câu tìm đã tính (khớp SĐT / khớp đầu chữ lên trước).
    const byId = new Map(rows.map((c) => [c.id, c]));
    const ordered = ids
      ? ids.flatMap((id) => {
          const row = byId.get(id);
          return row ? [row] : [];
        })
      : rows;
    return {
      data: ordered.map((c) => ({
        id: c.id.toString(),
        first_name: c.firstName,
        last_name: c.lastName,
        phone: c.phone,
        email: c.email,
        state: c.state,
        gender: c.gender,
        orders_count: c.ordersCount,
        total_spent: Number(c.totalSpent),
        label:
          [c.firstName, c.lastName].filter(Boolean).join(' ') ||
          c.phone ||
          c.email,
      })),
    };
  }

  /**
   * Khách đã có có thể trùng với khách sắp tạo (SĐT, họ tên, địa chỉ). Khai báo
   * trước `:id` để Nest không hiểu `duplicates` là một id.
   */
  @Get('duplicates')
  @RequirePermission('customer:view', 'customer:manage')
  duplicates(@Query() query: CustomerDuplicateQueryDto) {
    return this.customers.findDuplicates(query);
  }

  @Get(':id')
  @RequirePermission('customer:view', 'order:create')
  findOne(@Param('id') id: string) {
    return this.customers.findOne(BigInt(id));
  }

  @Post()
  @RequirePermission('customer:manage')
  create(@Body() dto: CreateCustomerDto) {
    return this.customers.create(dto);
  }

  @Put(':id')
  @RequirePermission('customer:manage')
  update(@Param('id') id: string, @Body() dto: UpdateCustomerDto) {
    return this.customers.update(BigInt(id), dto);
  }

  @Delete(':id')
  @RequirePermission('customer:manage')
  remove(@Param('id') id: string) {
    return this.customers.remove(BigInt(id));
  }

  @Get(':id/ledger')
  @RequirePermission('customer:view')
  getLedger(
    @Param('id') id: string,
    @Query() query: ListCustomerLedgerQueryDto,
  ) {
    return this.debt.getLedger(BigInt(id), query);
  }

  @Post(':id/debt-adjustments')
  @RequirePermission('customer:manage')
  createDebtAdjustment(
    @Param('id') id: string,
    @Body() dto: CreateCustomerDebtAdjustmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.debt.createAdjustment(BigInt(id), dto, user);
  }
}
