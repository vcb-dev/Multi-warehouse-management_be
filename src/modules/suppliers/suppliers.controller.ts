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
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import {
  CreateDebtAdjustmentDto,
  CreateSupplierDto,
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
  @RequirePermission('purchasing:manage', 'inventory:view')
  list(@Query() query: ListSuppliersQueryDto) {
    return this.suppliers.list(query);
  }

  @Post()
  @RequirePermission('purchasing:manage')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateSupplierDto) {
    return this.suppliers.create(dto);
  }

  @Get(':id')
  @RequirePermission('purchasing:manage', 'inventory:view')
  findOne(@Param('id') id: string) {
    return this.suppliers.findOne(BigInt(id));
  }

  @Put(':id')
  @RequirePermission('purchasing:manage')
  update(@Param('id') id: string, @Body() dto: UpdateSupplierDto) {
    return this.suppliers.update(BigInt(id), dto);
  }

  @Delete(':id')
  @RequirePermission('purchasing:manage')
  remove(@Param('id') id: string) {
    return this.suppliers.softDelete(BigInt(id));
  }

  @Get(':id/summary')
  @RequirePermission('purchasing:manage', 'inventory:view')
  getSummary(@Param('id') id: string, @Query() query: SupplierSummaryQueryDto) {
    return this.suppliers.getSummary(BigInt(id), query);
  }

  @Get(':id/ledger')
  @RequirePermission('purchasing:manage', 'inventory:view')
  getLedger(@Param('id') id: string, @Query() query: ListSupplierLedgerQueryDto) {
    return this.suppliers.getLedger(BigInt(id), query);
  }

  @Get(':id/next-lot-code')
  @RequirePermission('purchasing:manage', 'inventory:receive')
  getNextLotCode(@Param('id') id: string) {
    return this.suppliers.getNextLotCode(BigInt(id));
  }

  @Post(':id/debt-adjustments')
  @RequirePermission('purchasing:manage')
  @HttpCode(HttpStatus.CREATED)
  createDebtAdjustment(
    @Param('id') id: string,
    @Body() dto: CreateDebtAdjustmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.suppliers.createDebtAdjustment(BigInt(id), dto, user);
  }
}
