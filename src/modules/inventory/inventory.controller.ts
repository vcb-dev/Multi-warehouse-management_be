import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import {
  ListInventoryQueryDto,
  ListMovementsQueryDto,
} from './inventory.dto';
import {
  InventoryExportService,
  InventoryImportService,
} from './inventory-import-export.service';
import { InventoryQueryService } from './inventory-query.service';
import { ReconcileService } from './reconcile.service';

@ApiTags('inventory')
@ApiBearerAuth()
@Controller('inventory')
export class InventoryController {
  constructor(
    private query: InventoryQueryService,
    private reconcile: ReconcileService,
    private exporter: InventoryExportService,
    private importer: InventoryImportService,
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

  @Get('export')
  @RequirePermission('inventory:view')
  async export(
    @Query() query: ListInventoryQueryDto,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const buffer = await this.exporter.exportExcel(query, user);
    res.setHeader('Content-Disposition', 'attachment; filename="ton-kho.xlsx"');
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.send(buffer);
  }

  @Post('import')
  @RequirePermission('inventory:receive')
  @UseInterceptors(FileInterceptor('file'))
  async import(
    @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined,
    @Query('warehouse_id') warehouseId: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    if (!file?.buffer) {
      return { updated: 0, errors: [{ row: 0, message: 'Thiếu file' }] };
    }
    if (!warehouseId) {
      return { updated: 0, errors: [{ row: 0, message: 'Thiếu kho áp dụng' }] };
    }
    return this.importer.importExcel(file.buffer, BigInt(warehouseId), user);
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
