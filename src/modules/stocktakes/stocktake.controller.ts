import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import {
  CreateStocktakeDto,
  ListStocktakesQueryDto,
  UpdateStocktakeDto,
} from './stocktake.dto';
import { StocktakeService } from './stocktake.service';

@ApiTags('stocktakes')
@ApiBearerAuth()
@Controller('stocktakes')
export class StocktakeController {
  constructor(private stocktakes: StocktakeService) {}

  @Get()
  @RequirePermission('inventory:stocktake', 'inventory:view')
  list(@Query() query: ListStocktakesQueryDto, @CurrentUser() user: AuthUser) {
    return this.stocktakes.list(query, user);
  }

  @Post()
  @RequirePermission('inventory:stocktake')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateStocktakeDto, @CurrentUser() user: AuthUser) {
    return this.stocktakes.create(dto, user);
  }

  @Get(':id')
  @RequirePermission('inventory:stocktake', 'inventory:view')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.stocktakes.findOne(BigInt(id), user);
  }

  /** Lưu số đếm / ghi chú. Chỉ dùng được khi phiếu còn `checking`. */
  @Put(':id')
  @RequirePermission('inventory:stocktake')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateStocktakeDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.stocktakes.update(BigInt(id), dto, user);
  }

  /** Chốt phiếu: kéo tồn về đúng số đếm, sinh movement `adjust` gắn phiếu. */
  @Post(':id/balance')
  @RequirePermission('inventory:stocktake')
  balance(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.stocktakes.balance(BigInt(id), user);
  }

  @Post(':id/cancel')
  @RequirePermission('inventory:stocktake')
  cancel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.stocktakes.cancel(BigInt(id), user);
  }
}
