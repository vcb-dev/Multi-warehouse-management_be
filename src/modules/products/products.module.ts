import { Module } from '@nestjs/common';
import { CategoriesModule } from '../categories/categories.module';
import { ProductExportService, ProductImportService } from './product-import.service';
import { ProductRepository } from './product.repository';
import { ProductService } from './product.service';
import { ProductsController } from './products.controller';
import { VariantService } from './variant.service';

@Module({
  imports: [CategoriesModule],
  controllers: [ProductsController],
  providers: [
    ProductRepository,
    ProductService,
    VariantService,
    ProductImportService,
    ProductExportService,
  ],
  exports: [ProductService, ProductRepository, VariantService],
})
export class ProductsModule {}
