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
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { findCustomerIdsByQuery } from '../../common/search/unaccent-search';
import { CustomerDebtService } from './customer-debt.service';
import { CustomerService } from './customer.service';
import {
  CreateCustomerDto,
  ListCustomersQueryDto,
  UpdateCustomerDto,
} from './customer.dto';
import {
  CreateCustomerDebtAdjustmentDto,
  ListCustomerLedgerQueryDto,
} from './order.dto';

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
    const rows = await this.prisma.customer.findMany({
      where: term
        ? { id: { in: await findCustomerIdsByQuery(this.prisma, term) } }
        : undefined,
      take: 20,
      orderBy: { id: 'desc' },
    });
    return {
      data: rows.map((c) => ({
        id: c.id.toString(),
        first_name: c.firstName,
        last_name: c.lastName,
        phone: c.phone,
        email: c.email,
        state: c.state,
        gender: c.gender,
        orders_count: c.ordersCount,
        total_spent: Number(c.totalSpent),
        label: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.phone || c.email,
      })),
    };
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
  getLedger(@Param('id') id: string, @Query() query: ListCustomerLedgerQueryDto) {
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
