/**
 * Quickstart KC1–KC6 — specs/005-san-pham/quickstart.md
 * Chạy: RUN_INTEGRATION_TESTS=1 npm test -- test/quickstart-products.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { CategoriesModule } from '../src/modules/categories/categories.module';
import { CategoryService } from '../src/modules/categories/category.service';
import { PricingModule } from '../src/modules/pricing/pricing.module';
import { PriceListService } from '../src/modules/pricing/price-list.service';
import { ProductsModule } from '../src/modules/products/products.module';
import { ProductService } from '../src/modules/products/product.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { BusinessException } from '../src/common/exceptions/business.exception';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

describeIfDb('Quickstart 005 KC1–KC6 (integration)', () => {
  let products: ProductService;
  let categories: CategoryService;
  let pricing: PriceListService;
  let prisma: PrismaService;
  let userId: bigint;
  let branchId: bigint;
  let customerGroupId: bigint;

  const authUser = () => ({
    userId,
    email: 'admin@local.dev',
    roles: ['admin'],
    warehouseIds: [] as bigint[],
  });

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, ProductsModule, CategoriesModule, PricingModule],
    }).compile();

    products = module.get(ProductService);
    categories = module.get(CategoryService);
    pricing = module.get(PriceListService);
    prisma = module.get(PrismaService);

    const user = await prisma.user.findFirst({ where: { email: 'admin@local.dev' } });
    const branch = await prisma.branch.findFirst();
    const cg = await prisma.customerGroup.findFirst();
    if (!user || !branch || !cg) throw new Error('Run seed first');
    userId = user.id;
    branchId = branch.id;
    customerGroupId = cg.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('KC1 — 2 thuộc tính → 4 phiên bản, SKU unique', async () => {
    const ts = Date.now();
    const res = await products.create(
      {
        name: `Áo test ${ts}`,
        image_urls: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
        options: [
          { name: 'Màu', values: ['Đỏ', 'Xanh'] },
          { name: 'Size', values: ['M', 'L'] },
        ],
        variants: [
          { option_values: ['Đỏ', 'M'], sku: `KC1-${ts}-DM`, price: 100000 },
          { option_values: ['Đỏ', 'L'], sku: `KC1-${ts}-DL`, price: 100000 },
          { option_values: ['Xanh', 'M'], sku: `KC1-${ts}-XM`, price: 100000 },
          { option_values: ['Xanh', 'L'], sku: `KC1-${ts}-XL`, price: 100000 },
        ],
      },
      authUser(),
    );
    expect(res.variant_count).toBe(4);

    const images = await prisma.productImage.findMany({
      where: { productId: BigInt(res.id) },
    });
    expect(images).toHaveLength(2);
    expect(images.filter((i) => i.isPrimary)).toHaveLength(1);

    await expect(
      products.create(
        {
          name: 'Trùng SKU',
          variants: [{ option_values: [], sku: `KC1-${ts}-DM`, price: 1 }],
        },
        authUser(),
      ),
    ).rejects.toMatchObject({ code: 'DUPLICATE_SKU' });
  });

  it('KC2 — SP không thuộc tính → 1 phiên bản', async () => {
    const ts = Date.now();
    const res = await products.create(
      {
        name: `SP đơn ${ts}`,
        variants: [{ option_values: [], sku: `SINGLE-${ts}`, price: 50000 }],
      },
      authUser(),
    );
    expect(res.variant_count).toBe(1);
  });

  it('KC3 — inventory rỗng sau tạo SP', async () => {
    const ts = Date.now();
    const created = await products.create(
      {
        name: `KC3 ${ts}`,
        variants: [{ option_values: [], sku: `KC3-${ts}`, price: 1 }],
      },
      authUser(),
    );
    const inv = await products.getInventory(BigInt(created.id), {}, authUser());
    expect(inv.data).toEqual([]);
  });

  it('KC4 — resolvePrice branch override', async () => {
    const variant = await prisma.productVariant.findFirst();
    if (!variant) throw new Error('No variant');

    await prisma.priceList.create({
      data: {
        code: `KC4-${Date.now()}`,
        name: 'KC4 test',
        branchId,
        items: {
          create: { variantId: variant.id, fixedPrice: 999_000, enabled: true },
        },
      },
    });

    const resolved = await pricing.resolvePrice(variant.id, {
      branch_id: branchId,
    });
    expect(resolved.source).toBe('branch');
    expect(resolved.price).toBe(999_000);
  });

  it('KC5 — danh mục auto gán theo brand', async () => {
    const brand = `Moiss-${Date.now()}`;
    const cat = await categories.create({
      name: `DM auto ${Date.now()}`,
      condition_type: 'auto',
      auto_conditions: { brand },
    });

    const p = await products.create(
      {
        name: 'SP Moiss',
        brand,
        variants: [{ option_values: [], sku: `MOISS-${Date.now()}`, price: 1 }],
      },
      authUser(),
    );

    const link = await prisma.productCategory.findFirst({
      where: {
        productId: BigInt(p.id),
        categoryId: BigInt(cat.id),
      },
    });
    expect(link).toBeTruthy();
  });

  it('KC6 — export trả buffer Excel', async () => {
    const { ProductExportService } = await import(
      '../src/modules/products/product-import.service'
    );
    const exporter = new ProductExportService(products);
    const buf = await exporter.exportExcel({});
    expect(buf.length).toBeGreaterThan(100);
  });
});

describe('Quickstart 005 (unit)', () => {
  it('BusinessException DUPLICATE_SKU code', () => {
    const err = new BusinessException('DUPLICATE_SKU', 'test', 409);
    expect(err.code).toBe('DUPLICATE_SKU');
  });
});
