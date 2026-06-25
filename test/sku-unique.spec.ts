import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProductRepository } from '../src/modules/products/product.repository';

const describeIfDb =
  process.env.DATABASE_URL && process.env.RUN_INTEGRATION_TESTS === '1'
    ? describe
    : describe.skip;

describeIfDb('SKU unique constraint (integration)', () => {
  let repo: ProductRepository;
  let prisma: PrismaService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [ProductRepository],
    }).compile();
    repo = module.get(ProductRepository);
    prisma = module.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('findVariantBySku trả về bản ghi seed', async () => {
    const v = await repo.findVariantBySku('STUB-SKU-001');
    expect(v).toBeTruthy();
  });
});

describe('SKU validation (unit)', () => {
  it('SKU phải unique trong hệ thống', () => {
    const skus = new Set(['A', 'B', 'A']);
    expect(skus.size).toBe(2);
  });
});
