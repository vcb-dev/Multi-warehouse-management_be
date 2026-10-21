import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import {
  LocationOptional,
  RequirePermission,
} from '../../common/decorators/permissions.decorator';
import { ConfigService } from './config.service';
import {
  CreateLocationDto,
  ListLocationsQueryDto,
  UpdateLocationDto,
} from './dto/location.dto';

@ApiTags('config')
@ApiBearerAuth()
@Controller()
export class ConfigController {
  constructor(private config: ConfigService) {}

  /** Selector kho + màn CRUD. include_inactive chỉ có tác dụng với staff:manage. */
  @Get('locations')
  listLocations(
    @CurrentUser() user: AuthUser,
    @Query() query: ListLocationsQueryDto,
  ) {
    return this.config.listLocations(user, query);
  }

  @Post('locations')
  @RequirePermission('staff:manage')
  @LocationOptional()
  createLocation(@Body() dto: CreateLocationDto) {
    return this.config.createLocation(dto);
  }

  @Patch('locations/:id')
  @RequirePermission('staff:manage')
  @LocationOptional()
  updateLocation(@Param('id') id: string, @Body() dto: UpdateLocationDto) {
    return this.config.updateLocation(BigInt(id), dto);
  }

  @Delete('locations/:id')
  @RequirePermission('staff:manage')
  @LocationOptional()
  deactivateLocation(@Param('id') id: string) {
    return this.config.deactivateLocation(BigInt(id));
  }
}
