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
  UseInterceptors,
} from '@nestjs/common';
import { CostVisibilityInterceptor } from '../../common/interceptors/cost-visibility.interceptor';
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
@UseInterceptors(CostVisibilityInterceptor)
@Controller('stocktakes')
export class StocktakeController {
  constructor(private stocktakes: StocktakeService) {}

  @Get()
  @RequirePermission('stocktake:view')
  list(@Query() query: ListStocktakesQueryDto, @CurrentUser() user: AuthUser) {
    return this.stocktakes.list(query, user);
  }

  @Post()
  @RequirePermission('stocktake:manage')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateStocktakeDto, @CurrentUser() user: AuthUser) {
    return this.stocktakes.create(dto, user);
  }

  @Get(':id')
  @RequirePermission('stocktake:view_detail')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.stocktakes.findOne(BigInt(id), user);
  }

  /** Lưu số đếm / ghi chú. Chỉ dùng được khi phiếu còn `checking`. */
  @Put(':id')
  @RequirePermission('stocktake:manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateStocktakeDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.stocktakes.update(BigInt(id), dto, user);
  }

  /** Chốt phiếu: kéo tồn về đúng số đếm, sinh movement `adjust` gắn phiếu. */
  @Post(':id/balance')
  @RequirePermission('stocktake:balance')
  balance(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.stocktakes.balance(BigInt(id), user);
  }

  @Post(':id/cancel')
  @RequirePermission('stocktake:manage')
  cancel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.stocktakes.cancel(BigInt(id), user);
  }
}
