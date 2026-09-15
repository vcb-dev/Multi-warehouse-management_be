/**
 * Tên phân loại + ảnh của phiên bản trong dữ liệu tồn kho — thứ để người bán
 * chọn đúng mã khi thêm sản phẩm vào đơn (không ai nhớ hết SPU).
 *
 * Phần thuần hàm chạy luôn; phần chạm DB cần:
 *   RUN_INTEGRATION_TESTS=1 npm test -- test/inventory-variant-title.spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { InventoryModule } from '../src/modules/inventory/inventory.module';
import { InventoryQueryService } from '../src/modules/inventory/inventory-query.service';
import { variantTitle } from '../src/modules/inventory/inventory.serializer';
import { adminAuth } from './helpers/auth';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

const user = adminAuth();

describe('variantTitle', () => {
  it('giữ nguyên tên phân loại thật', () => {
    expect(variantTitle('Size 35 / Màu Đen')).toBe('Size 35 / Màu Đen');
  });

  it('bỏ chỗ trống và nhãn mặc định của Sapo', () => {
    expect(variantTitle(null)).toBeNull();
    expect(variantTitle('   ')).toBeNull();
    expect(variantTitle('Default Title')).toBeNull();
    expect(variantTitle('default title')).toBeNull();
  });
});

describeIfDb('dữ liệu chọn hàng của màn đơn hàng', () => {
  let inventory: InventoryQueryService;
  let prisma: PrismaService;
  let locationId: string;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, InventoryModule],
    }).compile();
    inventory = module.get(InventoryQueryService);
    prisma = module.get(PrismaService);
    const location = await prisma.location.findFirstOrThrow({
      orderBy: { id: 'asc' },
    });
    locationId = location.id.toString();
  }, 60_000);

  afterAll(() => prisma.$disconnect());

  it('các phiên bản của cùng một sản phẩm phân biệt được bằng tên phân loại', async () => {
    // Sản phẩm nhiều phiên bản, mỗi phiên bản có tên phân loại riêng — đúng
    // trường hợp người bán phải chọn giữa các mã na ná nhau.
    const [target] = await prisma.$queryRaw<{ product_id: bigint }[]>`
      SELECT product_id
      FROM product_variants
      WHERE enabled AND title IS NOT NULL AND title <> 'Default Title'
      GROUP BY product_id
      HAVING count(DISTINCT title) > 1
      LIMIT 1
    `;
    const variants = await prisma.productVariant.findMany({
      where: { productId: target.product_id, enabled: true },
      select: { id: true },
    });

    const res = await inventory.listInventory(
      {
        location_id: locationId,
        variant_ids: variants.map((v) => v.id.toString()).join(','),
        page_size: 50,
      },
      user,
    );

    expect(res.data.length).toBeGreaterThan(1);
    const titles = res.data.map((r) => r.variant_title);
    expect(titles.filter(Boolean).length).toBeGreaterThan(1);
    expect(new Set(titles).size).toBeGreaterThan(1);
    // Cùng một sản phẩm nên tên sản phẩm trùng nhau — nếu chỉ hiện tên thì
    // người bán không có cách nào chọn đúng mã.
    expect(new Set(res.data.map((r) => r.product_name)).size).toBe(1);
  }, 120_000);

  it('nhánh mọi kho cũng trả tên phân loại và ảnh', async () => {
    const res = await inventory.listInventory({ page_size: 20 }, user);
    expect(res.data.length).toBeGreaterThan(0);
    for (const row of res.data) {
      expect(row).toHaveProperty('variant_title');
      expect(row).toHaveProperty('image_url');
      expect(row.variant_title).not.toBe('Default Title');
    }
  }, 120_000);
});
