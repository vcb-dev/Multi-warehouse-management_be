import { GhnLocationResolver } from '../src/modules/fulfillments/carriers/ghn-location-resolver';
import type { GhnClient } from '../src/modules/fulfillments/carriers/ghn.client';

/**
 * App lưu tên hành chính theo vn-address.json ("Thành phố Hà Nội", "Quận Ba Đình") còn GHN
 * viết ngắn ("Hà Nội", "Ba Đình") — resolver phải khớp được cả hai cách viết.
 */
const CREDS = { token: 'tk', shopId: '1' };

function makeClient(overrides: Partial<GhnClient> = {}) {
  const calls = { provinces: 0, districts: 0, wards: 0 };
  const client = {
    getProvinces: jest.fn(async () => {
      calls.provinces++;
      return [
        { ProvinceID: 201, ProvinceName: 'Hà Nội', NameExtension: ['Hanoi'] },
        { ProvinceID: 202, ProvinceName: 'Hồ Chí Minh' },
      ];
    }),
    getDistricts: jest.fn(async () => {
      calls.districts++;
      return [
        { DistrictID: 1482, DistrictName: 'Ba Đình' },
        { DistrictID: 1483, DistrictName: 'Hoàn Kiếm' },
      ];
    }),
    getWards: jest.fn(async () => {
      calls.wards++;
      return [
        { WardCode: '1A0101', WardName: 'Phúc Xá' },
        { WardCode: '1A0102', WardName: 'Trúc Bạch' },
      ];
    }),
    ...overrides,
  } as unknown as GhnClient;
  return { client, calls };
}

describe('GHN-3 map tên tỉnh/huyện/xã sang ID của GHN', () => {
  it('khớp dù app có tiền tố hành chính mà GHN không có', async () => {
    const { client } = makeClient();
    const resolver = new GhnLocationResolver(client);
    await expect(
      resolver.resolve(
        {
          province: 'Thành phố Hà Nội',
          district: 'Quận Ba Đình',
          ward: 'Phường Phúc Xá',
        },
        CREDS,
      ),
    ).resolves.toEqual({ districtId: 1482, wardCode: '1A0101' });
  });

  it('khớp cả khi tên viết không dấu', async () => {
    const { client } = makeClient();
    const resolver = new GhnLocationResolver(client);
    await expect(
      resolver.resolve(
        { province: 'Ha Noi', district: 'Ba Dinh', ward: 'Truc Bach' },
        CREDS,
      ),
    ).resolves.toEqual({ districtId: 1482, wardCode: '1A0102' });
  });

  it('cache master data — gọi 2 lần chỉ tải danh sách 1 lần', async () => {
    const { client, calls } = makeClient();
    const resolver = new GhnLocationResolver(client);
    const addr = { province: 'Hà Nội', district: 'Ba Đình', ward: 'Phúc Xá' };
    await resolver.resolve(addr, CREDS);
    await resolver.resolve(addr, CREDS);
    expect(calls).toEqual({ provinces: 1, districts: 1, wards: 1 });
  });

  it('báo lỗi rõ cấp nào không khớp thay vì giao sai địa chỉ', async () => {
    const { client } = makeClient();
    const resolver = new GhnLocationResolver(client);
    await expect(
      resolver.resolve(
        { province: 'Hà Nội', district: 'Quận Không Tồn Tại', ward: 'Phúc Xá' },
        CREDS,
      ),
    ).rejects.toThrow(/Quận\/Huyện/);
  });

  it('thiếu bất kỳ cấp nào thì chặn ngay, không gọi API GHN', async () => {
    const { client, calls } = makeClient();
    const resolver = new GhnLocationResolver(client);
    await expect(
      resolver.resolve(
        { province: 'Hà Nội', district: 'Ba Đình', ward: null },
        CREDS,
      ),
    ).rejects.toThrow(/Phường\/Xã/);
    expect(calls.provinces).toBe(0);
  });

  it('khớp một phần mơ hồ (nhiều ứng viên) thì báo lỗi, không đoán', async () => {
    const { client } = makeClient({
      getWards: jest.fn(async () => [
        { WardCode: '1', WardName: 'Tân Bình 1' },
        { WardCode: '2', WardName: 'Tân Bình 2' },
      ]),
    });
    const resolver = new GhnLocationResolver(client);
    await expect(
      resolver.resolve(
        { province: 'Hà Nội', district: 'Ba Đình', ward: 'Tân Bình' },
        CREDS,
      ),
    ).rejects.toThrow(/Phường\/Xã/);
  });
});
