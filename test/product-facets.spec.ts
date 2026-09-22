/**
 * `GET /products/tags`, `/product-types` và `/vendors` gom giá trị sẵn có
 * bằng raw SQL (unnest + unaccent) — Prisma không diễn tả được, nên chỉ chạy
 * thật mới biết câu SQL có đúng không.
 * Chạy: RUN_INTEGRATION_TESTS=1 npm test -- test/product-facets.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProductsModule } from '../src/modules/products/products.module';
import { CategoriesModule } from '../src/modules/categories/categories.module';
import { PricingModule } from '../src/modules/pricing/pricing.module';
import { ProductService } from '../src/modules/products/product.service';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

describeIfDb('danh sách tag, loại sản phẩm và nhãn hiệu', () => {
  let products: ProductService;
  let prisma: PrismaService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, ProductsModule, CategoriesModule, PricingModule],
    }).compile();
    products = module.get(ProductService);
    prisma = module.get(PrismaService);
  });

  afterAll(() => prisma.$disconnect());

  it('trả tag kèm số sản phẩm, xếp theo lượt dùng giảm dần', async () => {
    const res = await products.listTags({ limit: 20 });
    expect(res.data.length).toBeGreaterThan(0);
    expect(res.data.length).toBeLessThanOrEqual(20);
    for (const row of res.data) {
      expect(typeof row.tag).toBe('string');
      expect(row.tag).not.toBe('');
      expect(typeof row.product_count).toBe('number');
      expect(row.product_count).toBeGreaterThan(0);
    }
    const counts = res.data.map((r) => r.product_count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it('lọc theo q, bỏ dấu tiếng Việt', async () => {
    const [top] = (await products.listTags({ limit: 1 })).data;
    // Bỏ dấu chuỗi tìm kiếm: kết quả vẫn phải chứa tag gốc (còn dấu).
    const q = top.tag.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const res = await products.listTags({ q });
    expect(res.data.map((r) => r.tag)).toContain(top.tag);
  });

  it('trả loại sản phẩm kèm số sản phẩm, xếp theo lượt dùng giảm dần', async () => {
    const res = await products.listProductTypes({ limit: 20 });
    expect(res.data.length).toBeGreaterThan(0);
    expect(res.data.length).toBeLessThanOrEqual(20);
    for (const row of res.data) {
      expect(typeof row.product_type).toBe('string');
      expect(row.product_type).not.toBe('');
      expect(row.product_count).toBeGreaterThan(0);
    }
    const counts = res.data.map((r) => r.product_count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it('lọc loại sản phẩm theo q, bỏ dấu tiếng Việt', async () => {
    const [top] = (await products.listProductTypes({ limit: 1 })).data;
    const q = top.product_type.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const res = await products.listProductTypes({ q });
    expect(res.data.map((r) => r.product_type)).toContain(top.product_type);
  });

  it('trả nhãn hiệu kèm số sản phẩm, xếp theo lượt dùng giảm dần', async () => {
    const res = await products.listVendors({ limit: 20 });
    expect(res.data.length).toBeGreaterThan(0);
    expect(res.data.length).toBeLessThanOrEqual(20);
    for (const row of res.data) {
      expect(typeof row.vendor).toBe('string');
      expect(row.vendor).not.toBe('');
      expect(row.product_count).toBeGreaterThan(0);
    }
    const counts = res.data.map((r) => r.product_count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it('lọc nhãn hiệu theo q, bỏ dấu tiếng Việt', async () => {
    const [top] = (await products.listVendors({ limit: 1 })).data;
    const q = top.vendor.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const res = await products.listVendors({ q });
    expect(res.data.map((r) => r.vendor)).toContain(top.vendor);
  });
});
