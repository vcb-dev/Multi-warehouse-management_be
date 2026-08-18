/**
 * Chốt chặn kho khi sửa giá của bảng giá theo kho.
 *
 * `PUT /price-lists/:id/items` mang id ở path còn kho nằm trên BẢN GHI, nên
 * `PermissionGuard` không có gì để kiểm — `@LocationOptional` ở route này chỉ nhằm mở
 * đường cho bảng giá toàn cục. Thiếu chốt ở tầng service thì người có `product:manage`
 * tại kho A sửa được giá của bảng giá thuộc kho B.
 */
import { PriceListService } from '../src/modules/pricing/price-list.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { BusinessException } from '../src/common/exceptions/business.exception';
import type { AuthUser } from '../src/common/decorators/current-user.decorator';

const KHO_A = '1';
const KHO_B = '2';

const userTaiKhoA: AuthUser = {
  userId: 9n,
  email: 'nv@test',
  roles: ['sales'],
  locationIds: [1n],
  warehousePermissions: { [KHO_A]: ['product:manage'] },
};

const admin: AuthUser = {
  userId: 1n,
  email: 'admin@test',
  roles: ['admin'],
  locationIds: [1n],
  isAdmin: true,
};

function build(priceList: { id: bigint; locationId: bigint | null }) {
  const tx = {
    priceListItem: { upsert: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    priceList: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(priceList),
      findUnique: jest.fn().mockResolvedValue({ ...priceList, items: [] }),
    },
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<void>) => fn(tx)),
  } as unknown as PrismaService;
  return { service: new PriceListService(prisma), prisma, tx };
}

const items = [{ variant_id: '100', fixed_price: 50_000 }];

describe('upsertItems — bảng giá gắn với một kho', () => {
  it('sửa bảng giá của kho KHÁC -> chặn', async () => {
    const { service } = build({ id: 5n, locationId: BigInt(KHO_B) });
    await expect(
      service.upsertItems(5n, items, userTaiKhoA),
    ).rejects.toBeInstanceOf(BusinessException);
  });

  it('bị chặn thì KHÔNG ghi item nào', async () => {
    // Quan trọng hơn cả việc ném lỗi: chặn phải xảy ra TRƯỚC khi đụng dữ liệu.
    const { service, tx, prisma } = build({
      id: 5n,
      locationId: BigInt(KHO_B),
    });
    await service.upsertItems(5n, items, userTaiKhoA).catch(() => undefined);
    expect(tx.priceListItem.upsert).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('sửa bảng giá của ĐÚNG kho mình có quyền -> cho qua', async () => {
    const { service, tx } = build({ id: 5n, locationId: BigInt(KHO_A) });
    await service.upsertItems(5n, items, userTaiKhoA);
    expect(tx.priceListItem.upsert).toHaveBeenCalledTimes(1);
  });

  it('admin sửa được bảng giá của mọi kho', async () => {
    const { service, tx } = build({ id: 5n, locationId: BigInt(KHO_B) });
    await service.upsertItems(5n, items, admin);
    expect(tx.priceListItem.upsert).toHaveBeenCalledTimes(1);
  });

  it('có quyền ở kho A nhưng KHÔNG phải product:manage -> vẫn chặn', async () => {
    const chiXem: AuthUser = {
      ...userTaiKhoA,
      warehousePermissions: { [KHO_A]: ['product:view'] },
    };
    const { service } = build({ id: 5n, locationId: BigInt(KHO_A) });
    await expect(service.upsertItems(5n, items, chiXem)).rejects.toBeInstanceOf(
      BusinessException,
    );
  });
});

describe('upsertItems — bảng giá toàn cục', () => {
  it('locationId null -> không đòi quyền theo kho', async () => {
    // Đây chính là trường hợp `@LocationOptional` sinh ra để phục vụ; chặn ở đây là
    // khoá luôn bảng giá chung của cả hệ thống.
    const { service, tx } = build({ id: 5n, locationId: null });
    await service.upsertItems(5n, items, userTaiKhoA);
    expect(tx.priceListItem.upsert).toHaveBeenCalledTimes(1);
  });
});
