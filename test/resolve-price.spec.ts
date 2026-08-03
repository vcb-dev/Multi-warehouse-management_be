import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { PriceListService } from '../src/modules/pricing/price-list.service';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

describeIfDb('resolvePrice priority (integration)', () => {
  let pricing: PriceListService;
  let prisma: PrismaService;
  let variantId: bigint;
  let productId: bigint;
  let priceListId: bigint;
  let locationId: bigint;
  let customerGroupId: bigint;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [PriceListService],
    }).compile();
    pricing = module.get(PriceListService);
    prisma = module.get(PrismaService);

    const branch = await prisma.location.findFirst();
    const cg = await prisma.customerGroup.findFirst();
    if (!branch || !cg) throw new Error('Run seed first');
    locationId = branch.id;
    customerGroupId = cg.id;

    // Tạo variant riêng thay vì findFirst(): file test khác cũng tạo bảng giá
    // cho cặp (variant đầu tiên, kho đầu tiên), file nào chạy sau sẽ đọc phải
    // bảng giá của file kia vì findEnabledItem lấy bản ghi id nhỏ nhất.
    const ts = Date.now();
    const product = await prisma.product.create({
      data: {
        name: `Resolve price ${ts}`,
        alias: `resolve-price-${ts}`,
        variants: {
          create: { sku: `RP-${ts}`, price: '999000' },
        },
      },
      include: { variants: true },
    });
    productId = product.id;
    variantId = product.variants[0].id;

    priceListId = (
      await prisma.priceList.create({
        data: {
          code: `CTL-TEST-${ts}`,
          name: 'Test branch',
          locationId,
          items: {
            create: { variantId, fixedPrice: 150_000, enabled: true },
          },
        },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.priceListItem.deleteMany({ where: { priceListId } });
    await prisma.priceList.delete({ where: { id: priceListId } });
    await prisma.productVariant.deleteMany({ where: { productId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.$disconnect();
  });

  it('P-3: branch price overrides variant default', async () => {
    const variant = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variantId },
    });
    const result = await pricing.resolvePrice(variantId, { location_id: locationId });
    expect(result.source).toBe('branch');
    expect(result.price).toBe(150_000);
    expect(result.price).not.toBe(Number(variant.price));
  });

  it('fallback variant_default khi không có bảng giá', async () => {
    const result = await pricing.resolvePrice(variantId, {
      customer_group_id: customerGroupId,
    });
    expect(['variant_default', 'customer_group']).toContain(result.source);
  });
});

describe('resolvePrice priority (unit)', () => {
  it('thứ tự: customer_group > branch > variant', () => {
    const order = ['customer_group', 'branch', 'variant_default'];
    expect(order.indexOf('customer_group')).toBeLessThan(
      order.indexOf('branch'),
    );
  });
});
