import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import {
  LocationOptional,
  RequirePermission,
} from '../../common/decorators/permissions.decorator';
import {
  ConnectProviderDto,
  CreateShippingPartnerDto,
  ListProvidersQueryDto,
  ListProviderServicesQueryDto,
  ProviderQuotesQueryDto,
  UpdateShippingProviderDto,
} from './fulfillment.dto';
import { ShippingProviderService } from './shipping-provider.service';

@ApiTags('shipping-providers')
@ApiBearerAuth()
@Controller('shipping-providers')
export class ShippingProvidersController {
  constructor(private providers: ShippingProviderService) {}

  @Get()
  @RequirePermission('order:pack', 'shipping:manage')
  list(@Query() query: ListProvidersQueryDto) {
    return this.providers.list(query.type);
  }

  @Get('quotes')
  @RequirePermission('order:pack')
  quotes(@Query() query: ProviderQuotesQueryDto) {
    return this.providers.quotes(query.weight_grams);
  }

  /** Danh sách dịch vụ THẬT theo tuyến — dùng cho màn review "Giao hàng hàng loạt". */
  @Get(':id/services')
  @RequirePermission('order:pack')
  listServices(
    @Param('id') id: string,
    @Query() query: ListProviderServicesQueryDto,
  ) {
    return this.providers.listServiceOptions(BigInt(id), {
      locationId: query.location_id ? BigInt(query.location_id) : undefined,
      toProvince: query.to_province,
      toDistrict: query.to_district,
      toWard: query.to_ward,
      weightGrams: query.weight_grams,
    });
  }

  @Post()
  @RequirePermission('order:pack', 'shipping:manage')
  @LocationOptional()
  createPartner(
    @Body() dto: CreateShippingPartnerDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.providers.createPartner(dto, user);
  }

  @Put(':id')
  @RequirePermission('shipping:manage')
  update(@Param('id') id: string, @Body() dto: UpdateShippingProviderDto) {
    return this.providers.update(BigInt(id), dto);
  }

  @Post(':id/connect')
  @RequirePermission('shipping:manage')
  connect(@Param('id') id: string, @Body() dto: ConnectProviderDto) {
    return this.providers.connect(BigInt(id), dto);
  }

  @Post(':id/disconnect')
  @RequirePermission('shipping:manage')
  disconnect(@Param('id') id: string) {
    return this.providers.disconnect(BigInt(id));
  }
}
