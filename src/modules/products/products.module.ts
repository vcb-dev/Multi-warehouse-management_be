import { Module } from '@nestjs/common';
import { CategoriesModule } from '../categories/categories.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ProductExportService, ProductImportService } from './product-import.service';
import { ProductRepository } from './product.repository';
import { ProductService } from './product.service';
import { ProductsController } from './products.controller';
import { VariantService } from './variant.service';

@Module({
  imports: [CategoriesModule, InventoryModule],
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
