/**
 * Sắp xếp danh sách theo cột: `?sort=price_asc` (Sản phẩm) và
 * `?sort=price_asc|cost_desc|on_hand_asc` (Tồn kho).
 *
 * Phải chạy thật mới kiểm được: hai nhánh nặng nhất đi qua SQL thô ("Giá từ" =
 * MIN giá phiên bản, "Tồn cuối kì" ở nhánh chọn kho) — Prisma không diễn tả
 * được nên tsc sạch không nói lên điều gì. Toàn bộ test chỉ ĐỌC.
 *
 * Chạy: RUN_INTEGRATION_TESTS=1 npm test -- test/list-sort.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProductsModule } from '../src/modules/products/products.module';
import { CategoriesModule } from '../src/modules/categories/categories.module';
import { PricingModule } from '../src/modules/pricing/pricing.module';
import { ProductService } from '../src/modules/products/product.service';
import { InventoryModule } from '../src/modules/inventory/inventory.module';
import { InventoryQueryService } from '../src/modules/inventory/inventory-query.service';
import { adminAuth } from './helpers/auth';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

const user = adminAuth();

/** Dãy số không giảm dần (asc) */
const isAsc = (xs: number[]) => xs.every((v, i) => i === 0 || xs[i - 1] <= v);
/** Dãy số không tăng dần (desc) */
const isDesc = (xs: number[]) => xs.every((v, i) => i === 0 || xs[i - 1] >= v);

describeIfDb('sắp xếp danh sách theo cột', () => {
  let products: ProductService;
  let inventory: InventoryQueryService;
  let prisma: PrismaService;
  let locationId: string;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        ProductsModule,
        CategoriesModule,
        PricingModule,
        InventoryModule,
      ],
    }).compile();
    products = module.get(ProductService);
    inventory = module.get(InventoryQueryService);
    prisma = module.get(PrismaService);

    const location = await prisma.location.findFirstOrThrow({
      orderBy: { id: 'asc' },
    });
    locationId = location.id.toString();
  }, 60_000);

  afterAll(() => prisma.$disconnect());

  describe('Sản phẩm — cột "Giá từ"', () => {
    it('price_asc mở đầu bằng giá thấp nhất của TOÀN danh sách, không phải của trang', async () => {
      const [bounds] = await prisma.$queryRaw<
        { min_price: number; max_price: number }[]
      >`
        SELECT MIN(COALESCE(v.price_from, 0))::float8 AS min_price,
               MAX(COALESCE(v.price_from, 0))::float8 AS max_price
        FROM products p
        LEFT JOIN (
          SELECT product_id, MIN(price) AS price_from
          FROM product_variants WHERE enabled GROUP BY product_id
        ) v ON v.product_id = p.id
      `;

      const asc = await products.list({ sort: 'price_asc', page_size: 5 });
      const prices = asc.data.map((p) => p.price_from);
      expect(prices).toHaveLength(5);
      expect(isAsc(prices)).toBe(true);
      expect(prices[0]).toBe(bounds.min_price);

      const desc = await products.list({ sort: 'price_desc', page_size: 5 });
      const descPrices = desc.data.map((p) => p.price_from);
      expect(isDesc(descPrices)).toBe(true);
      expect(descPrices[0]).toBe(bounds.max_price);
    }, 60_000);

    it('trang 2 nối tiếp trang 1, không lặp dòng', async () => {
      const p1 = await products.list({ sort: 'price_asc', page_size: 5 });
      const p2 = await products.list({
        sort: 'price_asc',
        page: 2,
        page_size: 5,
      });
      expect(isAsc([...p1.data, ...p2.data].map((p) => p.price_from))).toBe(
        true,
      );
      const ids = new Set(p1.data.map((p) => p.id));
      expect(p2.data.some((p) => ids.has(p.id))).toBe(false);
      expect(p2.total).toBe(p1.total);
    }, 60_000);

    it('giữ nguyên bộ lọc khi sắp xếp — total khớp nhánh không sắp xếp', async () => {
      const plain = await products.list({ is_published: true, page_size: 5 });
      const sorted = await products.list({
        is_published: true,
        sort: 'price_desc',
        page_size: 5,
      });
      expect(sorted.total).toBe(plain.total);
      expect(sorted.data.every((p) => p.is_published)).toBe(true);
      expect(isDesc(sorted.data.map((p) => p.price_from))).toBe(true);
    }, 60_000);

    it('sort lạ thì về thứ tự mặc định thay vì báo lỗi', async () => {
      const plain = await products.list({ page_size: 5 });
      const bogus = await products.list({
        sort: 'ten_asc' as 'price_asc',
        page_size: 5,
      });
      expect(bogus.data.map((p) => p.id)).toEqual(plain.data.map((p) => p.id));
    }, 60_000);
  });

  describe('Tồn kho — nhánh mọi kho', () => {
    it('xếp theo giá bán, cả hai chiều', async () => {
      const asc = await inventory.listInventory(
        { sort: 'price_asc', page_size: 5 },
        user,
      );
      expect(isAsc(asc.data.map((r) => Number(r.price)))).toBe(true);

      const desc = await inventory.listInventory(
        { sort: 'price_desc', page_size: 5 },
        user,
      );
      expect(isDesc(desc.data.map((r) => Number(r.price)))).toBe(true);
      expect(desc.total).toBe(asc.total);
    }, 120_000);

    it('xếp theo giá vốn', async () => {
      const desc = await inventory.listInventory(
        { sort: 'cost_desc', page_size: 5 },
        user,
      );
      expect(isDesc(desc.data.map((r) => Number(r.cost)))).toBe(true);
    }, 120_000);
  });

  describe('Tồn kho — nhánh chọn kho', () => {
    it('xếp theo giá bán', async () => {
      const asc = await inventory.listInventory(
        { location_id: locationId, sort: 'price_asc', page_size: 5 },
        user,
      );
      expect(isAsc(asc.data.map((r) => Number(r.price)))).toBe(true);
    }, 120_000);

    it('xếp theo tồn cuối kì trên TOÀN kho, kể cả dòng chưa có bản ghi tồn', async () => {
      const [bounds] = await prisma.$queryRaw<
        { min_on_hand: number; max_on_hand: number }[]
      >`
        SELECT MIN(COALESCE(l.on_hand, 0))::float8 AS min_on_hand,
               MAX(COALESCE(l.on_hand, 0))::float8 AS max_on_hand
        FROM product_variants v
        LEFT JOIN inventory_levels l
          ON l.variant_id = v.id AND l.location_id = ${BigInt(locationId)}
      `;

      const plain = await inventory.listInventory(
        { location_id: locationId, page_size: 5 },
        user,
      );
      const asc = await inventory.listInventory(
        { location_id: locationId, sort: 'on_hand_asc', page_size: 5 },
        user,
      );
      expect(asc.data).toHaveLength(5);
      expect(isAsc(asc.data.map((r) => r.on_hand))).toBe(true);
      expect(asc.data[0].on_hand).toBe(bounds.min_on_hand);
      expect(asc.total).toBe(plain.total);

      const desc = await inventory.listInventory(
        { location_id: locationId, sort: 'on_hand_desc', page_size: 5 },
        user,
      );
      expect(isDesc(desc.data.map((r) => r.on_hand))).toBe(true);
      expect(desc.data[0].on_hand).toBe(bounds.max_on_hand);
    }, 120_000);

    it('sắp xếp không làm mất bộ lọc (còn hàng)', async () => {
      const plain = await inventory.listInventory(
        { location_id: locationId, stock_status: 'in_stock', page_size: 5 },
        user,
      );
      const sorted = await inventory.listInventory(
        {
          location_id: locationId,
          stock_status: 'in_stock',
          sort: 'on_hand_asc',
          page_size: 5,
        },
        user,
      );
      expect(sorted.total).toBe(plain.total);
      expect(sorted.data.every((r) => r.available > 0)).toBe(true);
      expect(isAsc(sorted.data.map((r) => r.on_hand))).toBe(true);
    }, 120_000);
  });
});
