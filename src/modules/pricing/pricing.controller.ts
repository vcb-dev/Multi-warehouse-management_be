import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import {
  CreatePriceListDto,
  PriceListService,
} from './price-list.service';

@ApiTags('price-lists')
@ApiBearerAuth()
@Controller('price-lists')
export class PricingController {
  constructor(private pricing: PriceListService) {}

  @Get()
  @RequirePermission('product:manage')
  list() {
    return this.pricing.list();
  }

  @Post()
  @RequirePermission('product:manage')
  create(@Body() dto: CreatePriceListDto) {
    return this.pricing.create(dto);
  }

  @Get('resolve')
  @RequirePermission('product:view', 'product:manage')
  resolve(
    @Query('variant_id') variantId: string,
    @Query('location_id') locationId?: string,
    @Query('customer_group_id') customerGroupId?: string,
  ) {
    return this.pricing.resolveQuery(variantId, locationId, customerGroupId);
  }

  @Get(':id')
  @RequirePermission('product:manage')
  findOne(@Param('id') id: string) {
    return this.pricing.findOne(BigInt(id));
  }

  @Put(':id/items')
  @RequirePermission('product:manage')
  upsertItems(
    @Param('id') id: string,
    @Body()
    body: {
      items: {
        variant_id: string;
        fixed_price: number;
        compare_at_price?: number;
        enabled?: boolean;
      }[];
    },
  ) {
    return this.pricing.upsertItems(BigInt(id), body.items ?? []);
  }
}
