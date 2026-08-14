import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
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
import {
  LocationOptional,
  RequirePermission,
} from '../../common/decorators/permissions.decorator';
import { sendXlsx } from '../../common/utils/send-xlsx';
import {
  CreateProductDto,
  ListProductsQueryDto,
  ProductInventoryQueryDto,
  UpdateProductDto,
  VariantPriceHistoryQueryDto,
} from './product.dto';
import {
  ProductExportService,
  ProductImportService,
} from './product-import.service';
import { ProductService } from './product.service';

@ApiTags('products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(
    private products: ProductService,
    private importer: ProductImportService,
    private exporter: ProductExportService,
  ) {}

  @Get()
  @RequirePermission('product:view')
  list(@Query() query: ListProductsQueryDto) {
    return this.products.list(query);
  }

  @Post()
  @RequirePermission('product:manage')
  @LocationOptional()
  create(@Body() dto: CreateProductDto, @CurrentUser() user: AuthUser) {
    return this.products.create(dto, user);
  }

  @Get('export')
  @RequirePermission('product:manage')
  async export(@Query() query: ListProductsQueryDto, @Res() res: Response) {
    const buffer = await this.exporter.exportExcel(query);
    sendXlsx(res, buffer, 'san-pham.xlsx');
  }

  @Post('import')
  @RequirePermission('product:manage')
  @LocationOptional()
  @UseInterceptors(FileInterceptor('file'))
  async import(
    @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    if (!file?.buffer) {
      return {
        created: 0,
        updated: 0,
        errors: [{ row: 0, message: 'Thiếu file' }],
      };
    }
    return this.importer.importExcel(file.buffer, user);
  }

  @Get(':id/inventory')
  @RequirePermission('product:view', 'inventory:view')
  inventory(
    @Param('id') id: string,
    @Query() query: ProductInventoryQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.products.getInventory(BigInt(id), query, user);
  }

  @Get(':id')
  @RequirePermission('product:view')
  findOne(@Param('id') id: string) {
    return this.products.findOne(BigInt(id));
  }

  @Put(':id')
  @RequirePermission('product:manage')
  @LocationOptional()
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.products.update(BigInt(id), dto, user);
  }

  @Get(':id/variants/:variantId/price-history')
  @RequirePermission('product:view')
  getVariantPriceHistory(
    @Param('id') id: string,
    @Param('variantId') variantId: string,
    @Query() query: VariantPriceHistoryQueryDto,
  ) {
    return this.products.getVariantPriceHistory(
      BigInt(id),
      BigInt(variantId),
      query,
    );
  }
}
