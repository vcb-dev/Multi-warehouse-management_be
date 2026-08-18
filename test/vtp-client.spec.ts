import { BusinessException } from '../src/common/exceptions/business.exception';
import { VtpClient } from '../src/modules/fulfillments/carriers/vtp.client';

describe('VTP client', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('loginVtp gửi "tham số bí mật" trong body, không cần header Token', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 200,
        error: false,
        message: 'OK',
        data: { token: 'session-token', expired: Date.now() + 60_000 },
      }),
    } as Response);

    const client = new VtpClient();
    const result = await client.loginVtp('secret-abc');

    expect(result.token).toBe('session-token');
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Token).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({ token: 'secret-abc' });
  });

  it('các API khác gửi Token header từ creds (khác GHN không có ShopId)', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 200,
        error: false,
        message: 'OK',
        data: [],
      }),
    } as Response);

    const client = new VtpClient();
    await client.getPriceAllNlp(
      {
        SENDER_ADDRESS: 'A',
        RECEIVER_ADDRESS: 'B',
        RECEIVER_PROVINCE: 1,
        PRODUCT_TYPE: 'HH',
        PRODUCT_WEIGHT: 500,
        PRODUCT_PRICE: 100000,
        MONEY_COLLECTION: 0,
        PRODUCT_LENGTH: 0,
        PRODUCT_WIDTH: 0,
        PRODUCT_HEIGHT: 0,
        TYPE: 1,
      },
      { token: 'session-token' },
    );

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Token).toBe('session-token');
  });

  it('getPriceAllNlp bóc mảng dịch vụ từ RESULT — khác các endpoint khác, response này KHÔNG bọc trong {status,error,message,data}, trả thẳng {SENDER_ADDRESS, RECEIVER_ADDRESS, RESULT} ở top-level (xác nhận bằng gọi thật trên production 2026-08-10)', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        SENDER_ADDRESS: { PROVINCE_ID: 2 },
        RECEIVER_ADDRESS: { PROVINCE_ID: 1 },
        RESULT: [
          {
            MA_DV_CHINH: 'LCOD',
            TEN_DICHVU: 'Tiết kiệm',
            GIA_CUOC: 38708,
            THOI_GIAN: '72 giờ',
          },
        ],
      }),
    } as Response);

    const client = new VtpClient();
    const quotes = await client.getPriceAllNlp(
      {
        SENDER_ADDRESS: 'A',
        RECEIVER_ADDRESS: 'B',
        RECEIVER_PROVINCE: 1,
        PRODUCT_TYPE: 'HH',
        PRODUCT_WEIGHT: 500,
        PRODUCT_PRICE: 100000,
        MONEY_COLLECTION: 0,
        PRODUCT_LENGTH: 0,
        PRODUCT_WIDTH: 0,
        PRODUCT_HEIGHT: 0,
        TYPE: 1,
      },
      { token: 'session-token' },
    );

    expect(quotes).toEqual([
      {
        MA_DV_CHINH: 'LCOD',
        TEN_DICHVU: 'Tiết kiệm',
        GIA_CUOC: 38708,
        THOI_GIAN: '72 giờ',
      },
    ]);
  });

  it('ném BusinessException khi VTP trả error:true', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 422,
        error: true,
        message: 'Token không hợp lệ',
      }),
    } as Response);

    const client = new VtpClient();
    await expect(client.loginVtp('bad')).rejects.toThrow(BusinessException);
  });
});
