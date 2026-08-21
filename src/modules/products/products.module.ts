import { Module } from '@nestjs/common';
import { CategoriesModule } from '../categories/categories.module';
import { ProductExportService } from './product-export.service';
import { ProductImportService } from './product-import.service';
import { ProductRepository } from './product.repository';
import { ProductService } from './product.service';
import { ProductsController } from './products.controller';
import { SapoClient } from './sapo-sync/sapo-client';
import { SapoProductSyncScheduler } from './sapo-sync/sapo-product-sync.scheduler';
import { SapoProductSyncService } from './sapo-sync/sapo-product-sync.service';
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
    SapoClient,
    SapoProductSyncService,
    SapoProductSyncScheduler,
  ],
  exports: [
    ProductService,
    ProductRepository,
    VariantService,
    VariantPriceHistoryService,
    SapoProductSyncService,
  ],
})
export class ProductsModule {}
