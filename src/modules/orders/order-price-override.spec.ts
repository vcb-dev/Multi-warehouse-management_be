import { OrderService } from './order.service';
import type { CreateOrderDto } from './order.dto';
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_CATALOG,
} from '../rbac/permission-catalog';

/**
 * Quyền `order:override_price` (Sapo `override_item_price`): không có quyền thì
 * chỉ bán theo giá niêm yết. Kiểm ở tầng dựng dòng hàng, không chạm DB.
 */
function setup(listed: number[]) {
  const repo = {
    client: {
      productVariant: {
        findUnique: jest.fn().mockResolvedValue({
          id: 5n,
          sku: 'NHAN-01',
          product: { name: 'Nhẫn' },
        }),
      },
    },
  };
  const pricing = {
    resolvePrice: jest.fn().mockResolvedValue({ price: listed[0] }),
    listedPrices: jest.fn().mockResolvedValue(listed),
  };
  const service = new OrderService(
    repo as never,
    null as never,
    pricing as never,
    null as never,
    null as never,
    null as never,
  );
  const resolve = (price: number | undefined, canOverride: boolean) =>
    (
      service as unknown as {
        resolveItems: (
          dto: CreateOrderDto,
          canOverride: boolean,
        ) => Promise<{ price: number }[]>;
      }
    ).resolveItems(
      {
        location_id: '1',
        items: [{ variant_id: '5', location_id: '1', quantity: 1, price }],
      } as never,
      canOverride,
    );
  return { resolve, pricing };
}

describe('Sửa giá bán khi tạo đơn', () => {
  it('không có quyền: giá khác niêm yết bị từ chối', async () => {
    const { resolve } = setup([1_000_000, 900_000]);
    await expect(resolve(500_000, false)).rejects.toMatchObject({
      code: 'PRICE_OVERRIDE_FORBIDDEN',
      statusCode: 403,
    });
  });

  it('không có quyền: giá gốc hoặc giá trong bảng giá vẫn được', async () => {
    const { resolve } = setup([1_000_000, 900_000]);
    await expect(resolve(1_000_000, false)).resolves.toMatchObject([
      { price: 1_000_000 },
    ]);
    await expect(resolve(900_000, false)).resolves.toMatchObject([
      { price: 900_000 },
    ]);
  });

  it('không gửi giá thì lấy giá niêm yết, không cần quyền', async () => {
    const { resolve, pricing } = setup([1_000_000]);
    await expect(resolve(undefined, false)).resolves.toMatchObject([
      { price: 1_000_000 },
    ]);
    expect(pricing.listedPrices).not.toHaveBeenCalled();
  });

  it('có quyền: đặt giá tuỳ ý, không cần tra bảng giá', async () => {
    const { resolve, pricing } = setup([1_000_000]);
    await expect(resolve(500_000, true)).resolves.toMatchObject([
      { price: 500_000 },
    ]);
    expect(pricing.listedPrices).not.toHaveBeenCalled();
  });
});

describe('Vai trò mặc định theo kiểu vai trò trên Sapo', () => {
  const keys = new Set(PERMISSION_CATALOG.map((p) => p.key));
  const perms = (code: string) =>
    DEFAULT_ROLE_PERMISSIONS[code].permissions as string[];

  it('mọi quyền gán cho vai trò đều có trong danh mục', () => {
    for (const [code, def] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      if (def.permissions === '*') continue;
      for (const key of def.permissions) {
        expect({ code, key, known: keys.has(key) }).toEqual({
          code,
          key,
          known: true,
        });
      }
    }
  });

  it('hai vai trò bán hàng chỉ khác nhau ở quyền sửa giá', () => {
    const withPrice = new Set(perms('sales'));
    const fixed = new Set(perms('sales_fixed_price'));
    expect(fixed.has('order:override_price')).toBe(false);
    expect([...withPrice].filter((k) => !fixed.has(k))).toEqual([
      'order:override_price',
    ]);
    expect([...fixed].filter((k) => !withPrice.has(k))).toEqual([]);
  });

  it('Chỉ xem không có quyền ghi nào', () => {
    expect(perms('viewer').every((k) => k.endsWith(':view'))).toBe(true);
  });

  it('Trưởng nhóm quản lý nhân viên và xem lợi nhuận, không huỷ đơn, không xem giá vốn', () => {
    const lead = perms('team_lead');
    expect(lead).toEqual(
      expect.arrayContaining(['staff:manage', 'report:view_profit']),
    );
    expect(lead).not.toContain('order:cancel');
    expect(lead).not.toContain('product:view_cost');
    expect(lead).not.toContain('role:manage');
  });
});
