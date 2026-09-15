/**
 * Tạo sản phẩm kèm kho + tồn ban đầu từng phiên bản, và xoá bớt tổ hợp.
 * Unit test thuần (mock Prisma) — không chạm DB vì .env đang trỏ DB thật.
 */
import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { adminAuth, staffAuth } from '../../../test/helpers/auth';
import { CreateProductDto } from './product.dto';
import { ProductService } from './product.service';
import { VariantService } from './variant.service';

function makeService(opts: { activeLocationIds?: bigint[] } = {}) {
  let nextVariantId = 100n;
  const tx = {
    product: {
      create: jest.fn(async () => ({ id: 1n, name: 'Áo', alias: 'ao' })),
    },
    productOption: {
      create: jest.fn(async () => ({ id: BigInt((Math.random() * 1e6) | 0) })),
    },
    productVariant: {
      create: jest.fn(async () => ({ id: nextVariantId++ })),
    },
    variantOptionValue: { create: jest.fn() },
    inventoryLevel: { createMany: jest.fn() },
    activityLog: { create: jest.fn() },
  };
  const active = opts.activeLocationIds ?? [1n, 2n, 3n];
  const repo = {
    findVariantBySku: jest.fn(async () => null),
    findByAlias: jest.fn(async () => null),
    findById: jest.fn(async () => ({ id: 1n, variants: [] })),
    client: {
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      location: {
        findMany: jest.fn(async (args: { where: { id: { in: bigint[] } } }) =>
          args.where.id.in
            .filter((id) => active.includes(id))
            .map((id) => ({ id })),
        ),
      },
      productVariant: { count: jest.fn(async () => 0) },
    },
  };
  const inventory = { adjustOnHandTo: jest.fn() };
  const categories = { evaluateAutoForProduct: jest.fn() };
  const service = new ProductService(
    repo as never,
    new VariantService(),
    categories as never,
    {} as never,
    inventory as never,
  );
  return { service, tx, repo, inventory };
}

const variant = (
  option_values: string[],
  sku: string,
  extra: Record<string, unknown> = {},
) => ({ option_values, sku, price: 100_000, ...extra });

describe('CreateProductDto — kho của phiên bản', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const meta: ArgumentMetadata = { type: 'body', metatype: CreateProductDto };

  it('nhận variants[].inventories', async () => {
    await expect(
      pipe.transform(
        {
          name: 'Áo',
          variants: [
            variant([], 'A1', {
              inventories: [{ location_id: '1', on_hand: 5 }],
            }),
          ],
        },
        meta,
      ),
    ).resolves.toBeInstanceOf(CreateProductDto);
  });

  it('từ chối tồn âm và location_id không phải số', async () => {
    await expect(
      pipe.transform(
        {
          name: 'Áo',
          variants: [
            variant([], 'A1', {
              inventories: [{ location_id: 'kho-1', on_hand: -1 }],
            }),
          ],
        },
        meta,
      ),
    ).rejects.toThrow();
  });

  it('từ chối `initial_stock` cấp sản phẩm (form cũ gửi khoá này → 400)', async () => {
    await expect(
      pipe.transform(
        {
          name: 'Áo',
          variants: [variant([], 'A1')],
          initial_stock: [{ location_id: '1', quantity: 5 }],
        },
        meta,
      ),
    ).rejects.toThrow();
  });
});

describe('ProductService.create — phiên bản và tồn ban đầu', () => {
  const options = [
    { name: 'Màu', values: ['Đỏ', 'Xanh'] },
    { name: 'Size', values: ['S', 'M'] },
  ];

  it('chỉ tạo các tổ hợp có trong danh sách gửi lên', async () => {
    const { service, tx } = makeService();
    await service.create(
      {
        name: 'Áo',
        options,
        variants: [
          variant(['Đỏ', 'S'], 'DO-S'),
          variant(['Xanh', 'M'], 'XANH-M'),
        ],
      } as never,
      adminAuth(),
    );
    const skus = (
      tx.productVariant.create.mock.calls as unknown as [
        { data: { sku: string } },
      ][]
    ).map(([arg]) => arg.data.sku);
    expect(skus).toEqual(['DO-S', 'XANH-M']);
  });

  it('không gửi phiên bản nào thì vẫn sinh đủ tổ hợp (và đòi SKU)', async () => {
    const { service } = makeService();
    await expect(
      service.create({ name: 'Áo', options } as never, adminAuth()),
    ).rejects.toMatchObject({ code: 'SKU_REQUIRED' });
  });

  it('gắn phiên bản vào mọi kho đã chọn, chỉ ghi bút toán cho kho có tồn', async () => {
    const { service, tx, inventory } = makeService();
    await service.create(
      {
        name: 'Áo',
        options: [{ name: 'Size', values: ['S'] }],
        variants: [
          variant(['S'], 'AO-S', {
            cost: 60_000,
            inventories: [
              { location_id: '1', on_hand: 0 },
              { location_id: '2', on_hand: 7 },
            ],
          }),
        ],
      } as never,
      adminAuth({ userId: 9n }),
    );

    expect(tx.inventoryLevel.createMany).toHaveBeenCalledWith({
      data: [
        { variantId: 100n, locationId: 1n, price: 100_000, cost: 60_000 },
        { variantId: 100n, locationId: 2n, price: 100_000, cost: 60_000 },
      ],
      skipDuplicates: true,
    });
    expect(inventory.adjustOnHandTo).toHaveBeenCalledTimes(1);
    expect(inventory.adjustOnHandTo).toHaveBeenCalledWith(
      {
        variantId: 100n,
        locationId: 2n,
        targetOnHand: 7,
        referenceType: 'product',
        referenceId: 1n,
        createdById: 9n,
      },
      tx,
    );
  });

  it('kho không tồn tại / ngừng hoạt động bị chặn trước khi ghi gì', async () => {
    const { service, repo } = makeService({ activeLocationIds: [1n] });
    await expect(
      service.create(
        {
          name: 'Áo',
          variants: [
            variant([], 'AO', {
              inventories: [{ location_id: '2', on_hand: 1 }],
            }),
          ],
        } as never,
        adminAuth(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(repo.client.$transaction).not.toHaveBeenCalled();
  });

  it('không quản lý tồn kho thì không nhận tồn ban đầu > 0', async () => {
    const { service } = makeService();
    await expect(
      service.create(
        {
          name: 'Áo',
          track_inventory: false,
          variants: [
            variant([], 'AO', {
              inventories: [{ location_id: '1', on_hand: 3 }],
            }),
          ],
        } as never,
        adminAuth(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('nhập tồn ban đầu cần quyền nhập hàng tại đúng kho đó', async () => {
    const { service } = makeService();
    const user = staffAuth({
      warehousePermissions: {
        '1': ['inventory:receive'],
        '2': ['inventory:view'],
      },
    });
    const body = (locationId: string) =>
      ({
        name: 'Áo',
        variants: [
          variant([], `AO-${locationId}`, {
            inventories: [{ location_id: locationId, on_hand: 2 }],
          }),
        ],
      }) as never;

    await expect(service.create(body('2'), user)).rejects.toMatchObject({
      code: 'FORBIDDEN_SCOPE',
    });
    await expect(service.create(body('1'), user)).resolves.toMatchObject({
      id: '1',
    });
  });

  it('xoá hết tổ hợp thì báo lỗi thay vì tạo sản phẩm rỗng', async () => {
    const { service } = makeService();
    await expect(
      service.create(
        {
          name: 'Áo',
          options,
          variants: [variant(['Tím', 'XL'], 'TIM-XL')],
        } as never,
        adminAuth(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('ProductService.update — tồn kho', () => {
  it('không cho sửa tồn qua màn sản phẩm', async () => {
    const { service } = makeService();
    await expect(
      service.update(
        1n,
        {
          variants: [
            variant([], 'AO', {
              inventories: [{ location_id: '1', on_hand: 3 }],
            }),
          ],
        } as never,
        adminAuth(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
