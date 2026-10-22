import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  LocationOptional,
  RequirePermission,
} from '../../common/decorators/permissions.decorator';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import {
  CreateDebtAdjustmentDto,
  CreateSupplierDto,
  CreateSupplierPaymentDto,
  ListSuppliersQueryDto,
  ListSupplierLedgerQueryDto,
  SupplierSummaryQueryDto,
  UpdateSupplierDto,
} from './supplier.dto';
import { SupplierService } from './supplier.service';

@ApiTags('suppliers')
@ApiBearerAuth()
@Controller('suppliers')
export class SupplierController {
  constructor(private suppliers: SupplierService) {}

  @Get()
  @RequirePermission('supplier:view')
  list(@Query() query: ListSuppliersQueryDto) {
    return this.suppliers.list(query);
  }

  @Post()
  @RequirePermission('supplier:manage')
  @LocationOptional()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateSupplierDto) {
    return this.suppliers.create(dto);
  }

  @Get('debts')
  @RequirePermission('supplier:payment')
  listDebts() {
    return this.suppliers.listDebts();
  }

  @Get(':id')
  @RequirePermission('supplier:view_detail')
  findOne(@Param('id') id: string) {
    return this.suppliers.findOne(BigInt(id));
  }

  @Put(':id')
  @RequirePermission('supplier:manage')
  @LocationOptional()
  update(@Param('id') id: string, @Body() dto: UpdateSupplierDto) {
    return this.suppliers.update(BigInt(id), dto);
  }

  @Delete(':id')
  @RequirePermission('supplier:delete')
  @LocationOptional()
  remove(@Param('id') id: string) {
    return this.suppliers.softDelete(BigInt(id));
  }

  @Get(':id/summary')
  @RequirePermission('supplier:view_detail')
  getSummary(@Param('id') id: string, @Query() query: SupplierSummaryQueryDto) {
    return this.suppliers.getSummary(BigInt(id), query);
  }

  @Get(':id/ledger')
  @RequirePermission('supplier:view_detail')
  getLedger(
    @Param('id') id: string,
    @Query() query: ListSupplierLedgerQueryDto,
  ) {
    return this.suppliers.getLedger(BigInt(id), query);
  }

  @Post(':id/debt-adjustments')
  @RequirePermission('supplier:payment')
  @LocationOptional()
  @HttpCode(HttpStatus.CREATED)
  createDebtAdjustment(
    @Param('id') id: string,
    @Body() dto: CreateDebtAdjustmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.suppliers.createDebtAdjustment(BigInt(id), dto, user);
  }

  @Post(':id/payments')
  @RequirePermission('supplier:payment')
  @LocationOptional()
  @HttpCode(HttpStatus.CREATED)
  createPayment(
    @Param('id') id: string,
    @Body() dto: CreateSupplierPaymentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.suppliers.createPayment(BigInt(id), dto, user);
  }
}
