import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { ConfigService } from './config.service';

@ApiTags('config')
@ApiBearerAuth()
@Controller()
export class ConfigController {
  constructor(private config: ConfigService) {}

  /** Thay cho `/branches` + `/warehouses` cũ — Sapo chỉ có một Location. */
  @Get('locations')
  listLocations(@CurrentUser() user: AuthUser) {
    return this.config.listLocations(user);
  }
}
