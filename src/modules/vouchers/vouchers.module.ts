import { Global, Module } from '@nestjs/common';
import { VoucherController } from './voucher.controller';
import { VoucherService } from './voucher.service';

@Global()
@Module({
  controllers: [VoucherController],
  providers: [VoucherService],
  exports: [VoucherService],
})
export class VouchersModule {}
