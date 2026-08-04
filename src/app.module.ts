import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { JwtAuthGuard, PermissionGuard } from './common/guards/auth.guards';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { AuthModule } from './modules/auth/auth.module';
import { ConfigModule } from './modules/config/config.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { PurchasingModule } from './modules/purchasing/purchasing.module';
import { SuppliersModule } from './modules/suppliers/suppliers.module';
import { TransfersModule } from './modules/transfers/transfers.module';
import { ProductsModule } from './modules/products/products.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { OrderReturnsModule } from './modules/order-returns/order-returns.module';
import { ChannelsModule } from './modules/channels/channels.module';
import { VouchersModule } from './modules/vouchers/vouchers.module';
import { OrdersModule } from './modules/orders/orders.module';
import { FulfillmentsModule } from './modules/fulfillments/fulfillments.module';
import { ConversationModule } from './modules/conversations/conversation.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { ReportsModule } from './modules/reports/reports.module';
import { ApiKeysModule } from './modules/api-keys/api-keys.module';
import { PrismaModule } from './prisma/prisma.module';
import { StorageModule } from './common/storage/storage.module';

@Module({
  imports: [
    NestConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    StorageModule,
    VouchersModule,
    AuthModule,
    ConfigModule,
    InventoryModule,
    SuppliersModule,
    PurchasingModule,
    TransfersModule,
    ProductsModule,
    CategoriesModule,
    PricingModule,
    OrdersModule,
    FulfillmentsModule,
    OrderReturnsModule,
    ChannelsModule,
    ConversationModule,
    RbacModule,
    ReportsModule,
    ApiKeysModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
