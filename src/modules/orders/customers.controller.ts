import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { findCustomerIdsByQuery } from '../../common/search/unaccent-search';
import { CustomerDebtService } from './customer-debt.service';
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
  ) {}

  @Get()
  @RequirePermission('customer:view')
  async search(@Query('q') q?: string) {
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
        label: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.phone || c.email,
      })),
    };
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
