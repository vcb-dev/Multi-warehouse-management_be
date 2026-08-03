/**
 * SKU do người dùng nhập phải được giữ nguyên qua create lẫn update.
 * Chạy: RUN_INTEGRATION_TESTS=1 npm test -- test/product-sku-preserve.spec.ts
 *
 * Hồi quy: buildVariantRows từng luôn tự sinh SKU cho SP có thuộc tính, nên
 * update chỉ đổi giá cũng bị coi là "đổi SKU" → xoá-tạo lại phiên bản, hoặc
 * ném VARIANT_IN_USE khi phiên bản đã phát sinh tồn kho.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProductsModule } from '../src/modules/products/products.module';
import { CategoriesModule } from '../src/modules/categories/categories.module';
import { PricingModule } from '../src/modules/pricing/pricing.module';
import { adminAuth } from './helpers/auth';
import { ProductService } from '../src/modules/products/product.service';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

describeIfDb('update giữ SKU đang lưu', () => {
  let products: ProductService;
  let prisma: PrismaService;
  let userId: bigint;
  let locationId: bigint;

  const auth = () => adminAuth({ userId, locationIds: [locationId] });

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, ProductsModule, CategoriesModule, PricingModule],
    }).compile();
    products = module.get(ProductService);
    prisma = module.get(PrismaService);
    const u = await prisma.user.findFirstOrThrow({
      where: { email: 'admin@local.dev' },
    });
    const loc = await prisma.location.findFirstOrThrow();
    userId = u.id;
    locationId = loc.id;
  });

  afterAll(() => prisma.$disconnect());

  it('sửa giá khi variant đã có tồn kho: không mất SKU, không VARIANT_IN_USE', async () => {
    const ts = Date.now();
    const options = [
      { name: 'Màu', values: ['Đỏ', 'Xanh'] },
      { name: 'Size', values: ['M', 'L'] },
    ];
    const skus = [`UP-${ts}-DM`, `UP-${ts}-DL`, `UP-${ts}-XM`, `UP-${ts}-XL`];
    const created = await products.create(
      {
        name: `SP update ${ts}`,
        options,
        variants: [
          { option_values: ['Đỏ', 'M'], sku: skus[0], price: 1000 },
          { option_values: ['Đỏ', 'L'], sku: skus[1], price: 1000 },
          { option_values: ['Xanh', 'M'], sku: skus[2], price: 1000 },
          { option_values: ['Xanh', 'L'], sku: skus[3], price: 1000 },
        ],
      },
      auth(),
    );
    const productId = BigInt(created.id);

    const before = await prisma.productVariant.findMany({
      where: { productId },
      select: { id: true, sku: true },
      orderBy: { id: 'asc' },
    });
    expect(before.map((v) => v.sku).sort()).toEqual([...skus].sort());

    // Phát sinh tồn kho → variant bị chặn xoá.
    await prisma.inventoryLevel.create({
      data: { variantId: before[0].id, locationId, onHand: 5, available: 5 },
    });

    // Sửa giá, KHÔNG gửi sku — trước khi sửa lỗi sẽ ném VARIANT_IN_USE.
    await products.update(
      productId,
      {
        options,
        variants: [
          { option_values: ['Đỏ', 'M'], price: 2000 },
          { option_values: ['Đỏ', 'L'], price: 2000 },
          { option_values: ['Xanh', 'M'], price: 2000 },
          { option_values: ['Xanh', 'L'], price: 2000 },
        ],
      } as never,
      auth(),
    );

    const after = await prisma.productVariant.findMany({
      where: { productId },
      select: { id: true, sku: true, price: true },
      orderBy: { id: 'asc' },
    });
    // SKU giữ nguyên, variant không bị xoá-tạo lại (id không đổi), giá đã đổi.
    expect(after.map((v) => v.sku).sort()).toEqual([...skus].sort());
    expect(after.map((v) => v.id)).toEqual(before.map((v) => v.id));
    expect(after.every((v) => Number(v.price) === 2000)).toBe(true);

    await prisma.inventoryLevel.deleteMany({
      where: { variantId: before[0].id },
    });
  });
});
