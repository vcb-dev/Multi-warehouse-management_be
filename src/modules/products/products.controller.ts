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
import { CostVisibilityInterceptor } from '../../common/interceptors/cost-visibility.interceptor';
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
import {
  CreateProductDto,
  ExportProductsQueryDto,
  ListProductsQueryDto,
  ProductInventoryQueryDto,
  ProductFacetQueryDto,
  UpdateProductDto,
  VariantPriceHistoryQueryDto,
} from './product.dto';
import { ProductExportService } from './product-export.service';
import { ProductImportService } from './product-import.service';
import { ProductService } from './product.service';

@ApiTags('products')
@ApiBearerAuth()
@UseInterceptors(CostVisibilityInterceptor)
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
  @RequirePermission('product:create')
  @LocationOptional()
  create(@Body() dto: CreateProductDto, @CurrentUser() user: AuthUser) {
    return this.products.create(dto, user);
  }

  @Get('tags')
  @RequirePermission('product:view')
  tags(@Query() query: ProductFacetQueryDto) {
    return this.products.listTags(query);
  }

  @Get('product-types')
  @RequirePermission('product:view')
  productTypes(@Query() query: ProductFacetQueryDto) {
    return this.products.listProductTypes(query);
  }

  @Get('vendors')
  @RequirePermission('product:view')
  vendors(@Query() query: ProductFacetQueryDto) {
    return this.products.listVendors(query);
  }

  @Get('export/fields')
  @RequirePermission('product:export')
  exportFields(@CurrentUser() user: AuthUser) {
    return this.exporter.fields(user);
  }

  @Get('export')
  @RequirePermission('product:export')
  async export(
    @Query() query: ExportProductsQueryDto,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    await this.exporter.export(query, user, res);
  }

  @Post('import')
  @RequirePermission('product:import')
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
  @RequirePermission('product:view_detail', 'inventory:view')
  inventory(
    @Param('id') id: string,
    @Query() query: ProductInventoryQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.products.getInventory(BigInt(id), query, user);
  }

  @Get(':id')
  @RequirePermission('product:view_detail')
  findOne(@Param('id') id: string) {
    return this.products.findOne(BigInt(id));
  }

  @Put(':id')
  @RequirePermission('product:update')
  @LocationOptional()
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.products.update(BigInt(id), dto, user);
  }

  @Get(':id/variants/:variantId/price-history')
  @RequirePermission('product:view_detail')
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
