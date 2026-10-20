import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import { UpdateLocationSenderDto } from './config.dto';
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

  /**
   * Thông tin người gửi của kho (in trên phiếu giao, gửi sang hãng khi tạo vận
   * đơn) — cùng nhóm "Cấu hình vận chuyển".
   */
  @Put('locations/:id')
  @RequirePermission('shipping:manage')
  updateLocationSender(
    @Param('id') id: string,
    @Body() dto: UpdateLocationSenderDto,
  ) {
    return this.config.updateLocationSender(BigInt(id), dto);
  }
}
