import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import {
  LocationOptional,
  RequirePermission,
} from '../../common/decorators/permissions.decorator';
import { ChannelWebhookDto } from '../orders/order.dto';
import { ChannelSyncService } from './channel-sync.service';

@ApiTags('channels')
@ApiBearerAuth()
@Controller('channels')
export class ChannelsController {
  constructor(private sync: ChannelSyncService) {}

  @Post('webhook')
  @RequirePermission('order:create')
  @LocationOptional()
  webhook(@Body() dto: ChannelWebhookDto, @CurrentUser() user: AuthUser) {
    return this.sync.handleWebhook(dto, user);
  }

  @Post('sync')
  @RequirePermission('order:create')
  @LocationOptional()
  syncConnected(@CurrentUser() user: AuthUser) {
    return this.sync.syncConnectedChannels(user);
  }
}
