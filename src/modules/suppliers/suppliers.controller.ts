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
import {
  CreateSupplierDto,
  ListSuppliersQueryDto,
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
}
