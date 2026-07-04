import {
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import {
  ListInventoryQueryDto,
  ListLotsQueryDto,
  ListMovementsQueryDto,
} from './inventory.dto';
import { InventoryQueryService } from './inventory-query.service';
import { ReconcileService } from './reconcile.service';

@ApiTags('inventory')
@ApiBearerAuth()
@Controller('inventory')
export class InventoryController {
  constructor(
    private query: InventoryQueryService,
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
