import { GhnClient } from '../src/modules/fulfillments/carriers/ghn.client';

describe('GHN master-data client', () => {
  const creds = { token: 'test-token', shopId: '999' };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('getDistricts không gửi ShopId — master-data chỉ cần Token', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 200,
        data: [{ DistrictID: 1, DistrictName: 'Ba Đình' }],
      }),
    } as Response);

    const client = new GhnClient();
    const districts = await client.getDistricts(201, creds);

    expect(districts).toHaveLength(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Token).toBe('test-token');
    expect(headers.ShopId).toBeUndefined();
  });

  it('postList chuẩn hoá data object đơn thành mảng', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 200,
        data: { ProvinceID: 201, ProvinceName: 'Hà Nội' },
      }),
    } as Response);

    const client = new GhnClient();
    const provinces = await client.getProvinces(creds);
    expect(provinces).toEqual([{ ProvinceID: 201, ProvinceName: 'Hà Nội' }]);
  });
});
