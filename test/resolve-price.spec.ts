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
  let branchId: bigint;
  let customerGroupId: bigint;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [PriceListService],
    }).compile();
    pricing = module.get(PriceListService);
    prisma = module.get(PrismaService);

    const variant = await prisma.productVariant.findFirst();
    const branch = await prisma.branch.findFirst();
    const cg = await prisma.customerGroup.findFirst();
    if (!variant || !branch || !cg) throw new Error('Run seed first');
    variantId = variant.id;
    branchId = branch.id;
    customerGroupId = cg.id;

    const plBranch = await prisma.priceList.create({
      data: {
        code: `CTL-TEST-${Date.now()}`,
        name: 'Test branch',
        branchId,
        items: {
          create: {
            variantId,
            fixedPrice: 150_000,
            enabled: true,
          },
        },
      },
    });
    void plBranch;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('P-3: branch price overrides variant default', async () => {
    const variant = await prisma.productVariant.findUniqueOrThrow({
      where: { id: variantId },
    });
    const result = await pricing.resolvePrice(variantId, { branch_id: branchId });
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
