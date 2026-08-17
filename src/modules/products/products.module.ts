import { Module } from '@nestjs/common';
import { CategoriesModule } from '../categories/categories.module';
import { ProductExportService } from './product-export.service';
import { ProductImportService } from './product-import.service';
import { ProductRepository } from './product.repository';
import { ProductService } from './product.service';
import { ProductsController } from './products.controller';
import { VariantService } from './variant.service';
import { VariantPriceHistoryService } from './variant-price-history.service';

@Module({
  imports: [CategoriesModule],
  controllers: [ProductsController],
  providers: [
    ProductRepository,
    ProductService,
    VariantService,
    ProductImportService,
    ProductExportService,
    VariantPriceHistoryService,
  ],
  exports: [
    ProductService,
    ProductRepository,
    VariantService,
    VariantPriceHistoryService,
  ],
})
export class ProductsModule {}
