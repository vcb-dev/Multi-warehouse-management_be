import { OrderService } from './order.service';
import { UpdateOrderDto } from './order.dto';
import {
  buildShippingAddressPatch,
  type ShippingColumns,
} from './order-shipping-address';
import type { AuthUser } from '../../common/decorators/current-user.decorator';

/**
 * Sửa người nhận / địa chỉ giao của riêng một đơn. Không chạm DB: repository và
 * transaction là stub, phần cần khẳng định là service GHI những cột nào.
 */
jest.mock('./order.serializer', () => ({
  ...jest.requireActual('./order.serializer'),
  serializeOrderDetail: (order: unknown) => order,
}));

const admin: AuthUser = {
  userId: 7n,
  email: 'admin@example.com',
  roles: ['admin'],
  locationIds: [],
  isAdmin: true,
};

/** Đơn đồng bộ từ Sapo: có mã địa danh, toạ độ, address2, tách họ/tên */
const sapoAddress: ShippingColumns = {
  shippingName: 'Nguyễn Thị Thảo',
  shippingFirstName: 'Thảo',
  shippingLastName: 'Nguyễn Thị',
  shippingPhone: '0847674123',
  shippingAddress1: '12 Hàng Bạc',
  shippingAddress2: 'Tầng 3',
  shippingWard: 'Phường Hàng Bạc',
  shippingWardCode: '00070',
  shippingDistrict: 'Quận Hoàn Kiếm',
  shippingDistrictCode: '002',
  shippingProvince: 'Hà Nội',
  shippingProvinceCode: '01',
  shippingCity: null,
  shippingCountry: 'Việt Nam',
  shippingCountryCode: 'VN',
  shippingZip: '100000',
  shippingCompany: null,
  shippingLatitude: '21.0341' as never,
  shippingLongitude: '105.8522' as never,
};

describe('buildShippingAddressPatch', () => {
  it('chỉ ghi cột thực sự đổi — gửi lại y nguyên thì không ghi gì', () => {
    expect(
      buildShippingAddressPatch(sapoAddress, {
        name: 'Nguyễn Thị Thảo',
        phone: ' 0847674123 ',
        address1: '12 Hàng Bạc',
        ward: 'Phường Hàng Bạc',
        district: 'Quận Hoàn Kiếm',
        province: 'Hà Nội',
      }),
    ).toEqual({});
  });

  it('trường không gửi thì giữ — không làm mất address2/zip của đơn Sapo', () => {
    const patch = buildShippingAddressPatch(sapoAddress, {
      phone: '0912000111',
    });

    expect(patch).toEqual({ shippingPhone: '0912000111' });
  });

  it('gửi chuỗi rỗng là xoá', () => {
    expect(buildShippingAddressPatch(sapoAddress, { phone: '   ' })).toEqual({
      shippingPhone: null,
    });
  });

  it('đổi tên địa danh thì bỏ mã cũ và toạ độ cũ', () => {
    const patch = buildShippingAddressPatch(sapoAddress, {
      ward: 'Phường Tràng Tiền',
    });

    expect(patch).toEqual({
      shippingWard: 'Phường Tràng Tiền',
      shippingWardCode: null,
      shippingLatitude: null,
      shippingLongitude: null,
    });
  });

  it('đổi tên địa danh mà có gửi mã mới thì dùng mã mới', () => {
    const patch = buildShippingAddressPatch(sapoAddress, {
      province: 'TP Hồ Chí Minh',
      province_code: '79',
    });

    expect(patch).toMatchObject({
      shippingProvince: 'TP Hồ Chí Minh',
      shippingProvinceCode: '79',
    });
  });

  it('đổi tên người nhận thì bỏ bản tách họ/tên cũ, toạ độ giữ nguyên', () => {
    const patch = buildShippingAddressPatch(sapoAddress, {
      name: 'Trần Văn Nam',
    });

    expect(patch).toEqual({
      shippingName: 'Trần Văn Nam',
      shippingFirstName: null,
      shippingLastName: null,
    });
  });
});

function setup() {
  const order = {
    id: 1n,
    name: 'DH0001',
    locationId: 1n,
    status: 'open',
    confirmedOn: null,
    customerId: null,
    items: [],
    totalDiscounts: 0,
    totalShippingPrice: 0,
    totalTax: 0,
    totalPrice: 0,
    totalReceived: 0,
    email: 'cu@example.com',
    ...sapoAddress,
  };
  const orderUpdate = jest.fn().mockResolvedValue({ id: 1n });
  const logCreate = jest.fn().mockResolvedValue({});
  const tx = {
    order: { update: orderUpdate },
    activityLog: { create: logCreate },
  };
  const repo = {
    findById: jest.fn().mockResolvedValue(order),
    client: { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) },
  };
  const service = new OrderService(
    repo as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );
  return { service, orderUpdate, logCreate };
}

describe('OrderService.update — người nhận của đơn', () => {
  it('ghi địa chỉ giao và email lên đơn', async () => {
    const { service, orderUpdate } = setup();

    await service.update(
      1n,
      {
        email: ' moi@example.com ',
        shipping_address: { name: 'Trần Văn Nam', address1: '5 Lý Thái Tổ' },
      } as UpdateOrderDto,
      admin,
    );

    expect(orderUpdate.mock.calls[0][0].data).toMatchObject({
      email: 'moi@example.com',
      shippingName: 'Trần Văn Nam',
      shippingAddress1: '5 Lý Thái Tổ',
    });
    expect(orderUpdate.mock.calls[0][0].data).not.toHaveProperty(
      'shippingAddress2',
    );
  });

  it('lưu người nhận trước và sau vào lịch sử đơn', async () => {
    const { service, logCreate } = setup();

    await service.update(
      1n,
      { shipping_address: { phone: '0912000111' } } as UpdateOrderDto,
      admin,
    );

    expect(logCreate.mock.calls[0][0].data.metadata).toEqual({
      code: 'DH0001',
      recipient: {
        before: expect.objectContaining({ phone: '0847674123' }),
        after: expect.objectContaining({ phone: '0912000111' }),
      },
    });
  });

  it('không gửi người nhận thì lịch sử như cũ, không ghi cột địa chỉ', async () => {
    const { service, orderUpdate, logCreate } = setup();

    await service.update(1n, { note: 'Gọi trước' } as UpdateOrderDto, admin);

    expect(
      Object.keys(orderUpdate.mock.calls[0][0].data).filter((k) =>
        k.startsWith('shipping'),
      ),
    ).toEqual([]);
    expect(logCreate.mock.calls[0][0].data.metadata).toEqual({
      code: 'DH0001',
    });
  });
});
