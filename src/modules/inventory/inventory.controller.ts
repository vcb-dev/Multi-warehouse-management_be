import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import {
  AdjustInventoryDto,
  ListInventoryQueryDto,
  ListLotsQueryDto,
  ListMovementsQueryDto,
} from './inventory.dto';
import { InventoryQueryService } from './inventory-query.service';
import { InventoryService } from './inventory.service';
import { ReconcileService } from './reconcile.service';
import { serializeLevelBare } from './inventory.serializer';

@ApiTags('inventory')
@ApiBearerAuth()
@Controller('inventory')
export class InventoryController {
  constructor(
    private query: InventoryQueryService,
    private inventory: InventoryService,
    private reconcile: ReconcileService,
  ) {}

  @Get('reconcile')
  @RequirePermission('role:manage')
  runReconcile() {
    return this.reconcile.runFullReconcile();
  }

  @Get()
  @RequirePermission('inventory:view')
  list(@Query() query: ListInventoryQueryDto, @CurrentUser() user: AuthUser) {
    return this.query.listInventory(query, user);
  }

  @Post('adjust')
  @RequirePermission('inventory:adjust')
  async adjust(
    @Body() dto: AdjustInventoryDto,
    @CurrentUser() user: AuthUser,
  ) {
    const result = await this.inventory.adjustOnHand(
      {
        variantId: BigInt(dto.variant_id),
        warehouseId: BigInt(dto.warehouse_id),
        newOnHand: dto.new_on_hand,
        reason: dto.reason.trim(),
        createdById: user.userId,
      },
      user,
    );

    return {
      level: serializeLevelBare(result.level),
      movement_id: result.movementId?.toString() ?? null,
    };
  }

  @Get('lots')
  @RequirePermission('inventory:view')
  lots(@Query() query: ListLotsQueryDto) {
    return this.query.listLots(BigInt(query.variant_id));
  }

  @Get(':variantId/movements')
  @RequirePermission('inventory:view')
  movements(
    @Param('variantId') variantId: string,
    @Query() query: ListMovementsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.query.listMovements(BigInt(variantId), query, user);
  }
}
