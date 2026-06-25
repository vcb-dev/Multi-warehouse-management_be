import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import { CreateDraftOrderDto, UpdateDraftOrderDto } from '../orders/order.dto';
import { DraftOrderService } from './draft-order.service';

@ApiTags('draft-orders')
@ApiBearerAuth()
@Controller('draft-orders')
export class DraftOrderController {
  constructor(private drafts: DraftOrderService) {}

  @Get()
  @RequirePermission('draft_order:view')
  list(@CurrentUser() user: AuthUser) {
    return this.drafts.list(user);
  }

  @Get(':id')
  @RequirePermission('draft_order:view')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.drafts.findOne(BigInt(id), user);
  }

  @Post()
  @RequirePermission('draft_order:manage')
  create(@Body() dto: CreateDraftOrderDto, @CurrentUser() user: AuthUser) {
    return this.drafts.create(dto, user);
  }

  @Put(':id')
  @RequirePermission('draft_order:manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDraftOrderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.drafts.update(BigInt(id), dto, user);
  }

  @Post(':id/convert')
  @RequirePermission('draft_order:manage')
  convert(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.drafts.convert(BigInt(id), user);
  }
}
