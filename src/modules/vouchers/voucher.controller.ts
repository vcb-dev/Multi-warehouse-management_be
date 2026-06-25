import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import { ListVouchersQueryDto } from './voucher.dto';
import { VoucherService } from './voucher.service';

@ApiTags('vouchers')
@ApiBearerAuth()
@Controller('vouchers')
export class VoucherController {
  constructor(private vouchers: VoucherService) {}

  @Get()
  @RequirePermission('report:view', 'purchasing:manage')
  list(@Query() query: ListVouchersQueryDto) {
    return this.vouchers.list(query);
  }
}
