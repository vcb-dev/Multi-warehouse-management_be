import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { ReportService } from './report.service';
import { ReportsController } from './reports.controller';
import { IntegrationsReportsController } from './integrations-reports.controller';

@Module({
  imports: [
    ApiKeysModule,
    // Chỉ áp cho route tích hợp đối tác (IntegrationsReportsController tự khai
    // @Throttle) — không ảnh hưởng route JWT nội bộ trong ReportsController.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 60 }]),
  ],
  controllers: [ReportsController, IntegrationsReportsController],
  providers: [ReportService],
  exports: [ReportService],
})
export class ReportsModule {}
