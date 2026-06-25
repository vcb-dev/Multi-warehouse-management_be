import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ConfigService } from './config.service';

@ApiTags('config')
@ApiBearerAuth()
@Controller()
export class ConfigController {
  constructor(private config: ConfigService) {}

  @Get('branches')
  listBranches() {
    return this.config.listBranches();
  }

  @Get('warehouses')
  listWarehouses(@Query('branch_id') branchId?: string) {
    return this.config.listWarehouses(branchId ? BigInt(branchId) : undefined);
  }
}
