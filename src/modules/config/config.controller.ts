import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { ConfigService } from './config.service';

@ApiTags('config')
@ApiBearerAuth()
@Controller()
export class ConfigController {
  constructor(private config: ConfigService) {}

  @Get('branches')
  listBranches(@CurrentUser() user: AuthUser) {
    return this.config.listBranches(user);
  }

  @Get('warehouses')
  listWarehouses(
    @CurrentUser() user: AuthUser,
    @Query('branch_id') branchId?: string,
  ) {
    return this.config.listWarehouses(user, branchId ? BigInt(branchId) : undefined);
  }
}
