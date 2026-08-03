/**
 * unit/taxable/requires_shipping/track_inventory/allow_backorder phải được lưu.
 * Chạy: RUN_INTEGRATION_TESTS=1 npm test -- test/product-variant-flags.spec.ts
 *
 * Hồi quy: khối productVariant.create chỉ lấy 8 trường nên mọi cờ gửi lên đều
 * bị bỏ, người dùng gạt công tắc ở giao diện xong lưu là nó bật lại như cũ.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProductsModule } from '../src/modules/products/products.module';
import { CategoriesModule } from '../src/modules/categories/categories.module';
import { PricingModule } from '../src/modules/pricing/pricing.module';
import { ProductService } from '../src/modules/products/product.service';
import type { AuthUser } from '../src/common/decorators/current-user.decorator';
import { adminAuth } from './helpers/auth';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

describeIfDb('cờ variant được lưu qua create/update', () => {
  let products: ProductService;
  let prisma: PrismaService;
  let auth: AuthUser;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, ProductsModule, CategoriesModule, PricingModule],
    }).compile();
    products = module.get(ProductService);
    prisma = module.get(PrismaService);
    const u = await prisma.user.findFirstOrThrow({
      where: { email: 'admin@local.dev' },
    });
    auth = adminAuth({ userId: u.id, email: u.email });
  });

  afterAll(() => prisma.$disconnect());

  it('create lưu đúng cờ đã gửi', async () => {
    const ts = Date.now();
    const res = await products.create(
      {
        name: `Flags ${ts}`,
        unit: 'thùng',
        taxable: false,
        requires_shipping: false,
        track_inventory: false,
        allow_backorder: true,
        variants: [{ option_values: [], sku: `FLAG-${ts}`, price: 1000 }],
      } as never,
      auth,
    );
    const v = await prisma.productVariant.findFirstOrThrow({
      where: { productId: BigInt(res.id) },
    });
    expect(v.unit).toBe('thùng');
    expect(v.taxable).toBe(false);
    expect(v.requiresShipping).toBe(false);
    expect(v.inventoryManagement).toBe('');
    expect(v.inventoryPolicy).toBe('continue');
  });

  it('không gửi cờ thì dùng mặc định của cột', async () => {
    const ts = Date.now();
    const res = await products.create(
      {
        name: `Flags mặc định ${ts}`,
        variants: [{ option_values: [], sku: `FLAGD-${ts}`, price: 1000 }],
      } as never,
      auth,
    );
    const v = await prisma.productVariant.findFirstOrThrow({
      where: { productId: BigInt(res.id) },
    });
    expect(v.unit).toBeNull();
    expect(v.taxable).toBe(true);
    expect(v.requiresShipping).toBe(true);
    expect(v.inventoryManagement).toBe('bizweb');
    expect(v.inventoryPolicy).toBe('deny');
  });

  it('update đổi được cờ, và giữ nguyên cờ cũ khi request không gửi', async () => {
    const ts = Date.now();
    const options = [{ name: 'Màu', values: ['Đỏ'] }];
    const created = await products.create(
      {
        name: `Flags update ${ts}`,
        allow_backorder: true,
        taxable: false,
        options,
        variants: [{ option_values: ['Đỏ'], sku: `FLAGU-${ts}`, price: 1000 }],
      } as never,
      auth,
    );
    const productId = BigInt(created.id);

    // Chỉ đổi giá — cờ phải giữ nguyên.
    await products.update(
      productId,
      {
        options,
        variants: [{ option_values: ['Đỏ'], price: 2000 }],
      } as never,
      auth,
    );
    let v = await prisma.productVariant.findFirstOrThrow({
      where: { productId },
    });
    expect(Number(v.price)).toBe(2000);
    expect(v.inventoryPolicy).toBe('continue');
    expect(v.taxable).toBe(false);

    // Gửi cờ mới — phải ghi đè.
    await products.update(
      productId,
      {
        options,
        allow_backorder: false,
        taxable: true,
        variants: [{ option_values: ['Đỏ'], price: 2000 }],
      } as never,
      auth,
    );
    v = await prisma.productVariant.findFirstOrThrow({ where: { productId } });
    expect(v.inventoryPolicy).toBe('deny');
    expect(v.taxable).toBe(true);
  });
});
