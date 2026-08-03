/**
 * evaluateAutoForAllProducts — gán/gỡ đúng trên nhiều sản phẩm.
 * Chạy: RUN_INTEGRATION_TESTS=1 npm test -- test/category-auto-bulk.spec.ts
 *
 * Hồi quy: bản cũ mở một transaction cho mỗi sản phẩm nên tạo danh mục auto
 * trên kho 12k+ SP là treo request hàng giờ.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { CategoryConditionType } from '@prisma/client';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { CategoriesModule } from '../src/modules/categories/categories.module';
import { CategoryService } from '../src/modules/categories/category.service';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

describeIfDb('evaluateAutoForAllProducts', () => {
  let categories: CategoryService;
  let prisma: PrismaService;
  let categoryId: bigint;
  const productIds: bigint[] = [];
  const ts = Date.now();

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, CategoriesModule],
    }).compile();
    categories = module.get(CategoryService);
    prisma = module.get(PrismaService);

    // 3 SP khớp vendor, 2 SP không khớp.
    for (const [i, vendor] of [
      'AutoBrand',
      'AutoBrand',
      'AutoBrand',
      'KhácBrand',
      'KhácBrand',
    ].entries()) {
      const p = await prisma.product.create({
        data: {
          name: `Auto ${ts}-${i}`,
          alias: `auto-${ts}-${i}`,
          vendor,
          tags: [],
        },
      });
      productIds.push(p.id);
    }

    const cat = await prisma.category.create({
      data: {
        name: `Auto cat ${ts}`,
        alias: `auto-cat-${ts}`,
        conditionType: CategoryConditionType.auto,
        rules: { vendor: 'AutoBrand' },
      },
    });
    categoryId = cat.id;
  });

  afterAll(async () => {
    await prisma.productCategory.deleteMany({ where: { categoryId } });
    await prisma.category.delete({ where: { id: categoryId } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.$disconnect();
  });

  const assignedOfMine = async () => {
    const rows = await prisma.productCategory.findMany({
      where: { categoryId, productId: { in: productIds } },
      select: { productId: true },
    });
    return rows.map((r) => r.productId.toString()).sort();
  };

  it('gán đúng các SP khớp rule', async () => {
    await categories.evaluateAutoForAllProducts();
    expect(await assignedOfMine()).toEqual(
      productIds.slice(0, 3).map(String).sort(),
    );
  });

  it('chạy lại không nhân bản (idempotent)', async () => {
    await categories.evaluateAutoForAllProducts();
    expect(await assignedOfMine()).toHaveLength(3);
  });

  it('SP thôi khớp thì bị gỡ khỏi danh mục', async () => {
    await prisma.product.update({
      where: { id: productIds[0] },
      data: { vendor: 'ĐổiBrand' },
    });
    await categories.evaluateAutoForAllProducts();
    expect(await assignedOfMine()).toEqual(
      productIds.slice(1, 3).map(String).sort(),
    );
  });

  it('SP khớp trở lại thì được gán lại', async () => {
    await prisma.product.update({
      where: { id: productIds[0] },
      data: { vendor: 'AutoBrand' },
    });
    await categories.evaluateAutoForAllProducts();
    expect(await assignedOfMine()).toEqual(
      productIds.slice(0, 3).map(String).sort(),
    );
  });
});
